/**
 * Netlify Function — POST /.netlify/functions/upload_pdf
 *
 * Receives { filename, file_data (base64 PDF) }, extracts text, splits into
 * overlapping chunks, and persists them to PostgreSQL.
 * Retrieval uses keyword scoring at query time — no embedding API needed,
 * so the function completes well within Netlify's timeout limit.
 *
 * Returns { pdf_id, count }.
 *
 * Required Netlify environment variables:
 *   DATABASE_URL — PostgreSQL connection string (Neon / Supabase / etc.)
 */

'use strict';

const { randomUUID } = require('crypto');
const { Client }     = require('pg');
const pdfParse       = require('pdf-parse');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHUNK_SIZE    = 500;
const CHUNK_OVERLAP = 50;
const MAX_PDF_BYTES = 4 * 1024 * 1024; // 4 MB

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

async function getDb() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

async function ensureSchema(client) {
  // Create table if it does not exist yet
  await client.query(`
    CREATE TABLE IF NOT EXISTS pdf_chunks (
      id         SERIAL PRIMARY KEY,
      pdf_id     TEXT NOT NULL,
      chunk_text TEXT NOT NULL
    )
  `);
  // Old deployments had an embedding TEXT NOT NULL column.
  // Add it as nullable so existing tables accept inserts without an embedding.
  await client.query(`ALTER TABLE pdf_chunks ADD COLUMN IF NOT EXISTS embedding TEXT`);
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

    const { text } = await pdfParse(pdfBuffer);
    if (!text?.trim())
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Could not extract text from this PDF.' }) };

    const chunks = splitIntoChunks(text);
    const pdfId  = randomUUID();
    const client = await getDb();

    try {
      await ensureSchema(client);
      for (const chunk of chunks) {
        await client.query(
          'INSERT INTO pdf_chunks (pdf_id, chunk_text) VALUES ($1, $2)',
          [pdfId, chunk]
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
