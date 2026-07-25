/**
 * Netlify Function — POST /.netlify/functions/upload_pdf
 *
 * Receives { filename, file_data (base64 PDF) }, extracts text, splits into
 * overlapping chunks, attempts semantic embedding via HuggingFace (8 s timeout),
 * and persists everything to PostgreSQL.
 *
 * When HuggingFace is unavailable or slow the function still succeeds and stores
 * chunks with embedding = NULL.  rag_query.js then falls back to keyword search.
 *
 * Returns { pdf_id, count }.
 *
 * Required Netlify environment variables:
 *   DATABASE_URL         — PostgreSQL connection string (Neon / Supabase / etc.)
 *   HUGGINGFACE_API_KEY  — hf_*** token (optional but needed for semantic RAG)
 */

'use strict';

const { randomUUID } = require('crypto');
const { Client }     = require('pg');
// Use the lib path to skip the test-file read the top-level export triggers.
// Wrap in try-catch so a module-load failure returns a clean 500, not a 502.
let pdfParse;
try { pdfParse = require('pdf-parse/lib/pdf-parse.js'); }
catch (e) { console.error('pdf-parse load error:', e.message); }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HF_API_URL    = 'https://router.huggingface.co/hf-inference/models/sentence-transformers/all-MiniLM-L6-v2/pipeline/feature-extraction';
const CHUNK_SIZE    = 500;
const CHUNK_OVERLAP = 50;
const MAX_PDF_BYTES = 4 * 1024 * 1024; // 4 MB
const EMBED_BATCH   = 32;
// 5 s leaves ~5 s for pdf-parse + DB, comfortably within Netlify's 10 s limit
const HF_TIMEOUT_MS = 5000;

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitIntoChunks(text) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const chunk = text.slice(start, start + CHUNK_SIZE);
    if (chunk.trim()) chunks.push(chunk);
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks;
}

/**
 * Embed a batch of texts.
 * Returns the embedding array on success, or null on any failure / timeout.
 * Never throws — callers can always handle null gracefully.
 */
async function tryEmbedBatch(texts, apiKey) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HF_TIMEOUT_MS);
    const resp = await fetch(HF_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inputs: texts }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      console.warn(`HuggingFace API ${resp.status} — falling back to keyword search`);
      return null;
    }

    const raw = await resp.json();
    // Handle both bare array and { outputs: [...] } response shapes
    const vecs = Array.isArray(raw) ? raw : (raw.outputs ?? raw.data ?? null);
    if (!Array.isArray(vecs)) return null;

    return vecs.map(vec => {
      // sentence-transformers returns [float, ...]; guard against token-level shape
      if (Array.isArray(vec[0])) {
        const n = vec.length;
        return vec[0].map((_, i) => vec.reduce((s, row) => s + row[i], 0) / n);
      }
      return vec;
    });
  } catch (err) {
    console.warn('HuggingFace embed failed:', err.message, '— falling back to keyword search');
    return null;
  }
}

async function getDb() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

async function ensureSchema(client) {
  // Create table with nullable embedding (allows keyword-only fallback rows)
  await client.query(`
    CREATE TABLE IF NOT EXISTS pdf_chunks (
      id         SERIAL PRIMARY KEY,
      pdf_id     TEXT NOT NULL,
      chunk_text TEXT NOT NULL,
      embedding  TEXT
    )
  `);
  // Old deployments had embedding TEXT NOT NULL — make it nullable so new inserts work
  await client.query(`ALTER TABLE pdf_chunks ALTER COLUMN embedding DROP NOT NULL`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_pdf_chunks_pdf_id ON pdf_chunks (pdf_id)`);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    const { filename, file_data } = JSON.parse(event.body || '{}');

    if (!filename?.toLowerCase().endsWith('.pdf'))
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Please upload a PDF file.' }) };

    if (!file_data)
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'No file data received.' }) };

    const pdfBuffer = Buffer.from(file_data, 'base64');

    if (pdfBuffer.length > MAX_PDF_BYTES)
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'File exceeds the 4 MB size limit.' }) };

    if (!pdfParse)
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'PDF parser unavailable.' }) };

    const { text } = await pdfParse(pdfBuffer);
    if (!text?.trim())
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Could not extract text from this PDF.' }) };

    const chunks = splitIntoChunks(text);
    const hfKey  = process.env.HUGGINGFACE_API_KEY || '';

    // --- Attempt semantic embeddings (returns null per-batch on failure) --------
    let embeddings = [];
    let embeddingsFailed = false;

    if (hfKey) {
      for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        const batch = chunks.slice(i, i + EMBED_BATCH);
        const vecs  = await tryEmbedBatch(batch, hfKey);
        if (vecs === null) {
          embeddingsFailed = true;
          break;
        }
        embeddings.push(...vecs);
      }
    } else {
      embeddingsFailed = true; // no key → skip embedding
    }

    if (embeddingsFailed) embeddings = null; // signal keyword-only mode

    // --- Persist to PostgreSQL -------------------------------------------------
    const pdfId  = randomUUID();
    const client = await getDb();
    try {
      await ensureSchema(client);
      // Bulk insert all chunks in a single query — avoids N round-trips and
      // keeps total function time well under Netlify's 10 s limit.
      const embedStrs = embeddings
        ? embeddings.map(e => JSON.stringify(e))
        : chunks.map(() => null);
      await client.query(
        `INSERT INTO pdf_chunks (pdf_id, chunk_text, embedding)
         SELECT $1, unnest($2::text[]), unnest($3::text[])`,
        [pdfId, chunks, embedStrs]
      );
    } finally {
      await client.end();
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ pdf_id: pdfId, count: chunks.length }),
    };
  } catch (err) {
    console.error('upload_pdf error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
