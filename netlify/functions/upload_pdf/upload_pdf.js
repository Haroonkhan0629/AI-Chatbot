/**
 * Netlify Function — POST /.netlify/functions/upload_pdf
 *
 * Receives { filename, text } where `text` is already extracted by the browser
 * using PDF.js (client-side).  The function never touches a PDF library, so
 * there are zero Worker threads, zero native bindings, and zero 502 crashes.
 *
 * Splits the text into overlapping chunks, attempts semantic embedding via
 * HuggingFace (5 s timeout), and persists everything to PostgreSQL in a single
 * bulk INSERT.  Falls back to keyword search if HuggingFace is unavailable.
 *
 * Returns { pdf_id, count }.
 *
 * Required Netlify environment variables:
 *   DATABASE_URL         — PostgreSQL connection string (Neon / Supabase / etc.)
 *   HUGGINGFACE_API_KEY  — hf_*** token (optional; enables semantic RAG)
 */

'use strict';

const { randomUUID } = require('crypto');
const { Client }     = require('pg');

const HF_API_URL     = 'https://router.huggingface.co/hf-inference/models/sentence-transformers/all-MiniLM-L6-v2/pipeline/feature-extraction';
const CHUNK_SIZE     = 500;
const CHUNK_OVERLAP  = 50;
const MAX_TEXT_CHARS = 500000;
const EMBED_BATCH    = 32;
const HF_TIMEOUT_MS  = 3000; // 3 s cap — keeps total well inside Netlify's 10 s limit

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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

async function tryEmbedBatch(texts, apiKey) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HF_TIMEOUT_MS);
    const resp = await fetch(HF_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: texts }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) { console.warn(`HF ${resp.status}`); return null; }
    const raw  = await resp.json();
    const vecs = Array.isArray(raw) ? raw : (raw.outputs ?? raw.data ?? null);
    if (!Array.isArray(vecs)) return null;
    return vecs.map(vec => Array.isArray(vec[0])
      ? vec[0].map((_, i) => vec.reduce((s, r) => s + r[i], 0) / vec.length)
      : vec);
  } catch { console.warn('HF embed timed out'); return null; }
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
  await client.query(`
    CREATE TABLE IF NOT EXISTS pdf_chunks (
      id SERIAL PRIMARY KEY, pdf_id TEXT NOT NULL,
      chunk_text TEXT NOT NULL, embedding TEXT
    )`);
  await client.query(`ALTER TABLE pdf_chunks ALTER COLUMN embedding DROP NOT NULL`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_pdf_chunks_pdf_id ON pdf_chunks (pdf_id)`);
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  try {
    const { filename, text } = JSON.parse(event.body || '{}');

    if (!filename?.toLowerCase().endsWith('.pdf'))
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Please upload a PDF file.' }) };
    if (!text?.trim())
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'No text content received.' }) };
    if (text.length > MAX_TEXT_CHARS)
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Document too large (max 500 000 chars).' }) };

    const chunks = splitIntoChunks(text);
    const hfKey  = process.env.HUGGINGFACE_API_KEY || '';
    const pdfId  = randomUUID();

    // Run DB connection and HF embedding in parallel so their latencies overlap
    // instead of adding up (DB cold-start ~3s + HF ~3s would exceed 10s limit).
    async function embedAll() {
      if (!hfKey) return null;
      const all = [];
      for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        const vecs = await tryEmbedBatch(chunks.slice(i, i + EMBED_BATCH), hfKey);
        if (!vecs) return null; // fall back to keyword
        all.push(...vecs);
      }
      return all;
    }

    const [client, embeddings] = await Promise.all([getDb(), embedAll()]);

    try {
      await ensureSchema(client);
      const embedStrs = embeddings ? embeddings.map(e => JSON.stringify(e)) : chunks.map(() => null);
      await client.query(
        `INSERT INTO pdf_chunks (pdf_id, chunk_text, embedding)
         SELECT $1, unnest($2::text[]), unnest($3::text[])`,
        [pdfId, chunks, embedStrs]
      );
    } finally { await client.end(); }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ pdf_id: pdfId, count: chunks.length }) };
  } catch (err) {
    console.error('upload_pdf error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
