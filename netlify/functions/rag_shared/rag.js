'use strict';
/**
 * RAG logic, as plain functions (no classes). The Netlify functions call:
 *
 *   indexDocument(docId, text)      -> chunk + embed + store a PDF      (rag_ingest-background)
 *   getIndexStatus(docId)           -> 'processing' | 'ready' | 'error'  (rag_status)
 *   findRelevantChunks(docId, q, k) -> top-k chunk texts for a question  (rag_query)
 *
 * Helpers used by those three: embed(), getCollection(), semanticChunks().
 * This folder has no index.js, so Netlify does not deploy it as a function.
 */

const { CloudClient, ChromaClient } = require('chromadb');
const { InferenceClient } = require('@huggingface/inference');

const EMBED_MODEL = process.env.EMBED_MODEL || 'BAAI/bge-small-en-v1.5';
const COLLECTION = process.env.CHROMA_COLLECTION || 'pdf_chunks';
const EMBED_BATCH = 64;        // texts per Hugging Face call
const ADD_BATCH = 100;         // chunks per Chroma write
const BREAK_PERCENTILE = 0.9;  // cut where sentence-to-sentence distance is in the top 10%
const MAX_CHUNK_CHARS = 1500;
const MIN_CHUNK_CHARS = 200;
const QUERY_EMBED_TIMEOUT_MS = 5000;

// Written last when indexing; its presence means "all chunks are stored".
const markerId = docId => docId + ':done';

/** Texts in -> one vector per text out (Hugging Face), sent in batches. */
async function embed(texts) {
  const hf = new InferenceClient(process.env.HUGGINGFACE_API_KEY);
  const vectors = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH).map(t => t.replace(/\n/g, ' '));
    vectors.push(...(await hf.featureExtraction({ model: EMBED_MODEL, inputs: batch, provider: 'hf-inference' })));
  }
  return vectors;
}

/** Connect to Chroma (self-hosted if CHROMA_URL is set, else Chroma Cloud) and open the collection. */
function getCollection() {
  let client;
  if (process.env.CHROMA_URL) {
    const u = new URL(process.env.CHROMA_URL);
    const ssl = u.protocol === 'https:';
    client = new ChromaClient({
      host: u.hostname,
      port: Number(u.port) || (ssl ? 443 : 80),
      ssl,
      headers: process.env.CHROMA_AUTH_TOKEN
        ? { Authorization: 'Bearer ' + process.env.CHROMA_AUTH_TOKEN }
        : undefined,
    });
  } else {
    client = new CloudClient({
      apiKey: process.env.CHROMA_API_KEY,
      tenant: process.env.CHROMA_TENANT,
      database: process.env.CHROMA_DATABASE,
    });
  }
  // embeddingFunction: null -> Chroma never embeds anything; we always send our own vectors.
  return client.getOrCreateCollection({ name: COLLECTION, embeddingFunction: null });
}

/** Semantic chunking: embed every sentence and cut where the meaning changes most. */
async function semanticChunks(text) {
  const sentences = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/)
    .map(s => s.trim())
    .filter(Boolean);
  if (sentences.length < 2) return sentences;

  const vectors = await embed(sentences);
  const distances = []; // cosine distance between each sentence and the next one
  for (let i = 0; i < vectors.length - 1; i++) {
    const [a, b] = [vectors[i], vectors[i + 1]];
    let dot = 0, na = 0, nb = 0;
    for (let j = 0; j < a.length; j++) { dot += a[j] * b[j]; na += a[j] * a[j]; nb += b[j] * b[j]; }
    distances.push(1 - dot / (Math.sqrt(na) * Math.sqrt(nb) || 1));
  }
  const sorted = [...distances].sort((x, y) => x - y);
  const threshold = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * BREAK_PERCENTILE))];

  const chunks = [];
  let current = sentences[0];
  for (let i = 1; i < sentences.length; i++) {
    const bigJump = distances[i - 1] >= threshold && current.length >= MIN_CHUNK_CHARS;
    if (bigJump || current.length + sentences[i].length + 1 > MAX_CHUNK_CHARS) {
      chunks.push(current);
      current = sentences[i];
    } else {
      current += ' ' + sentences[i];
    }
  }
  chunks.push(current);
  return chunks;
}

/** Chunk, embed and store a document. Never throws: a failure is recorded as an error marker. */
async function indexDocument(docId, text) {
  const collection = await getCollection();
  try {
    const chunks = await semanticChunks(text);
    const vectors = await embed(chunks);

    for (let i = 0; i < chunks.length; i += ADD_BATCH) {
      const batch = chunks.slice(i, i + ADD_BATCH);
      await collection.upsert({
        ids: batch.map((_, j) => docId + ':' + (i + j)),
        embeddings: vectors.slice(i, i + ADD_BATCH),
        documents: batch,
        metadatas: batch.map((_, j) => ({ docId, chunkIndex: i + j })),
      });
    }
    await collection.upsert({
      ids: [markerId(docId)],
      embeddings: [vectors[0]],
      documents: ['done'],
      metadatas: [{ docId, marker: true, chunkCount: chunks.length }],
    });
  } catch (err) {
    console.error('indexDocument error:', err);
    await collection.upsert({
      ids: [markerId(docId)],
      embeddings: [new Array(384).fill(0)], // 384 = bge-small dimensions; Chroma needs some vector
      documents: ['error'],
      metadatas: [{ docId, marker: true, error: String(err.message).slice(0, 200) }],
    }).catch(() => {});
  }
}

/** 'processing' until the marker row exists, then 'ready' (or 'error' if the marker records a failure). */
async function getIndexStatus(docId) {
  const collection = await getCollection();
  const res = await collection.get({ ids: [markerId(docId)], include: ['metadatas'] });
  if (!res.ids.length) return { status: 'processing' };
  const error = res.metadatas[0] && res.metadatas[0].error;
  return error ? { status: 'error', error } : { status: 'ready' };
}

/** Embed the question, search this document's chunks in Chroma, return the top-k chunk texts. */
async function findRelevantChunks(docId, question, k) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Query embedding timed out')), QUERY_EMBED_TIMEOUT_MS);
  });
  const [queryVector] = await Promise.race([embed([question]), timeout]).finally(() => clearTimeout(timer));

  const collection = await getCollection();
  const res = await collection.query({
    queryEmbeddings: [queryVector],
    nResults: k + 1, // +1 because the marker row can also match; it is filtered out below
    where: { docId },
    include: ['documents', 'metadatas'],
  });
  return (res.documents[0] || [])
    .filter((_, i) => !(res.metadatas[0][i] && res.metadatas[0][i].marker))
    .slice(0, k);
}

module.exports = { indexDocument, getIndexStatus, findRelevantChunks };
