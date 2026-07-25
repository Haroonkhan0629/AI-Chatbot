/**
 * Netlify Function — POST /.netlify/functions/rag_query
 *
 * Fetches PDF chunks for the given pdf_id, then:
 *   • If chunks have embeddings → embeds the query via HuggingFace and ranks
 *     by cosine similarity (full semantic RAG).
 *   • If chunks have no embeddings → ranks by keyword TF-IDF score (fallback).
 * Returns a Groq-generated answer from the top-K context chunks.
 *
 * Required Netlify environment variables:
 *   DATABASE_URL         — PostgreSQL connection string (Neon / Supabase / etc.)
 *   GROQ_API_KEY         — from https://console.groq.com/keys
 *   HUGGINGFACE_API_KEY  — hf_*** token (needed for semantic RAG path)
 */

'use strict';

const { Client } = require('pg');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HF_API_URL   = 'https://router.huggingface.co/hf-inference/models/sentence-transformers/all-MiniLM-L6-v2/pipeline/feature-extraction';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL   = 'llama-3.3-70b-versatile';
const TOP_K        = 3;

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ---------------------------------------------------------------------------
// Semantic helpers
// ---------------------------------------------------------------------------

async function embedQuery(text, apiKey) {
  const resp = await fetch(HF_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: [text] }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`HuggingFace API ${resp.status}: ${body}`);
  }
  const raw = await resp.json();
  // Handle bare array or { outputs: [...] } response shapes
  const vecs = Array.isArray(raw) ? raw : (raw.outputs ?? raw.data ?? []);
  let vec = vecs[0];
  // Guard against token-level shape (array-of-arrays) → mean-pool
  if (Array.isArray(vec[0])) {
    const n = vec.length;
    vec = vec[0].map((_, i) => vec.reduce((s, row) => s + row[i], 0) / n);
  }
  return vec;
}

function cosineSim(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

// ---------------------------------------------------------------------------
// Keyword fallback helpers
// ---------------------------------------------------------------------------

function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
}

function keywordScore(chunk, queryTokens) {
  const words = tokenize(chunk);
  if (!words.length) return 0;
  const freq = new Map();
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  let score = 0;
  for (const t of queryTokens) {
    const f = freq.get(t) || 0;
    if (f > 0) score += 1 + Math.log(f);
  }
  return score / Math.sqrt(words.length);
}

// ---------------------------------------------------------------------------
// Retrieval — semantic if embeddings available, keyword otherwise
// ---------------------------------------------------------------------------

async function retrieveChunks(pdfId, query, hfKey) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const { rows } = await client.query(
      'SELECT chunk_text, embedding FROM pdf_chunks WHERE pdf_id = $1',
      [pdfId]
    );
    if (!rows.length) return [];

    const hasEmbeddings = rows.some(r => r.embedding !== null);

    if (hasEmbeddings && hfKey) {
      // --- Semantic path ---
      const queryVec = await embedQuery(query, hfKey);
      return rows
        .map(r => ({
          text:  r.chunk_text,
          score: r.embedding ? cosineSim(queryVec, JSON.parse(r.embedding)) : 0,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, TOP_K)
        .map(r => r.text);
    }

    // --- Keyword fallback ---
    const qTokens = tokenize(query);
    return rows
      .map(r => ({ text: r.chunk_text, score: keywordScore(r.chunk_text, qTokens) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_K)
      .map(r => r.text);
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    const { prompt, pdf_id } = JSON.parse(event.body || '{}');

    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey)
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'GROQ_API_KEY not configured.' }) };
    if (!pdf_id)
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'pdf_id is required.' }) };

    const hfKey  = process.env.HUGGINGFACE_API_KEY || '';
    const chunks = await retrieveChunks(pdf_id, prompt, hfKey);

    const context = chunks.length
      ? chunks.map((c, i) => `[${i + 1}] ${c}`).join('\n\n')
      : 'No relevant content found in the document.';

    const messages = [
      {
        role: 'system',
        content:
          'You are a helpful assistant. Answer the user\'s question using ONLY the ' +
          'provided document context. If the context does not contain enough ' +
          'information to answer, say so clearly.',
      },
      { role: 'user', content: `Context:\n${context}\n\nQuestion: ${prompt}` },
    ];

    const groqResp = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: GROQ_MODEL, messages, max_tokens: 1024 }),
    });
    if (!groqResp.ok)
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: `Groq API returned HTTP ${groqResp.status}.` }) };

    const data   = await groqResp.json();
    const answer = data.choices[0].message.content;

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ response: answer }) };
  } catch (err) {
    console.error('rag_query error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
