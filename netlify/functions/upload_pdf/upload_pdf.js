/**
 * Netlify Function — POST /.netlify/functions/upload_pdf
 *
 * Receives { filename, file_data (base64 PDF) }, extracts text, chunks it,
 * generates sentence embeddings via the HuggingFace Inference Providers API,
 * and persists everything to PostgreSQL.
 *
 * Returns { pdf_id, count }.
 *
 * Required Netlify environment variables:
 *   DATABASE_URL         — PostgreSQL connection string (Neon / Supabase / etc.)
 *   HUGGINGFACE_API_KEY  — hf_*** token from https://huggingface.co/settings/tokens
 */

'use strict';

const { randomUUID }   = require('crypto');
const { Client }       = require('pg');
// pdf-parse/lib/pdf-parse.js avoids the test-file read that the top-level
// require triggers in some serverless runtimes.
const pdfParse         = require('pdf-parse/lib/pdf-parse.js');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HF_API_URL    = 'https://router.huggingface.co/hf-inference/models/sentence-transformers/all-MiniLM-L6-v2/pipeline/feature-extraction';
const CHUNK_SIZE    = 500;
const CHUNK_OVERLAP = 50;
const MAX_PDF_BYTES = 4 * 1024 * 1024; // 4 MB
const EMBED_BATCH   = 32;              // texts per HuggingFace request

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

async function embedBatch(texts, apiKey) {
  const resp = await fetch(HF_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: texts }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`HuggingFace API ${resp.status}: ${body}`);
  }
  const raw = await resp.json();
  // sentence-transformers returns sentence vectors directly; guard against token-level
  return raw.map(vec => {
    if (Array.isArray(vec[0])) {
      const n = vec.length;
      return vec[0].map((_, i) => vec.reduce((s, row) => s + row[i], 0) / n);
    }
    return vec;
  });
}

async function getDb() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // required for Neon / Supabase
  });
  await client.connect();
  return client;
}

async function ensureSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS pdf_chunks (
      id         SERIAL PRIMARY KEY,
      pdf_id     TEXT    NOT NULL,
      chunk_text TEXT    NOT NULL,
      embedding  TEXT    NOT NULL
    )
  `);
  await client.query(
    'CREATE INDEX IF NOT EXISTS idx_pdf_chunks_pdf_id ON pdf_chunks (pdf_id)'
  );
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

    const pdfBuffer = Buffer.from(file_data, 'base64');

    if (!pdfBuffer.slice(0, 4).toString() === '%PDF')
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'File does not appear to be a valid PDF.' }) };

    if (pdfBuffer.length > MAX_PDF_BYTES)
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'File exceeds the 4 MB size limit.' }) };

    const { text } = await pdfParse(pdfBuffer);
    if (!text?.trim())
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Could not extract text from this PDF.' }) };

    const chunks  = splitIntoChunks(text);
    const hfKey   = process.env.HUGGINGFACE_API_KEY || '';

    // Embed in batches
    const embeddings = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);
      const vecs  = await embedBatch(batch, hfKey);
      embeddings.push(...vecs);
    }

    // Persist to PostgreSQL
    const pdfId  = randomUUID();
    const client = await getDb();
    try {
      await ensureSchema(client);
      for (let i = 0; i < chunks.length; i++) {
        await client.query(
          'INSERT INTO pdf_chunks (pdf_id, chunk_text, embedding) VALUES ($1, $2, $3)',
          [pdfId, chunks[i], JSON.stringify(embeddings[i])]
        );
      }
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
