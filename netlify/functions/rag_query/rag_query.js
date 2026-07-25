/**
 * Netlify Function — POST /.netlify/functions/rag_query
 *
 * Embeds the user's query via HuggingFace, fetches matching PDF chunks from
 * PostgreSQL, ranks them with cosine similarity, and returns a Groq-powered answer.
 *
 * Required Netlify environment variables:
 *   DATABASE_URL         — PostgreSQL connection string (Neon / Supabase / etc.)
 *   HUGGINGFACE_API_KEY  — hf_*** token from https://huggingface.co/settings/tokens
 *   GROQ_API_KEY         — from https://console.groq.com/keys
 */

'use strict';

const { Client } = require('pg');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HF_API_URL    = 'https://router.huggingface.co/hf-inference/models/sentence-transformers/all-MiniLM-L6-v2/pipeline/feature-extraction';
const GROQ_API_URL  = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL    = 'llama-3.3-70b-versatile';
const TOP_K         = 3;

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ---------------------------------------------------------------------------
// Helpers
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
  // raw[0] is the embedding for our single input
  let vec = raw[0];
  if (Array.isArray(vec[0])) {          // token-level → mean pool
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

async function retrieveChunks(pdfId, queryEmbedding) {
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

    return rows
      .map(row => ({
        text: row.chunk_text,
        score: cosineSim(queryEmbedding, JSON.parse(row.embedding)),
      }))
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

    const hfKey   = process.env.HUGGINGFACE_API_KEY || '';
    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'GROQ_API_KEY not configured.' }) };

    const queryEmbedding = await embedQuery(prompt, hfKey);
    const chunks         = await retrieveChunks(pdf_id, queryEmbedding);

    const context = chunks.length
      ? chunks.map((c, i) => `[${i + 1}] ${c}`).join('\n\n')
      : 'No relevant context found.';

    const messages = [
      {
        role: 'system',
        content:
          'You are a helpful assistant. Answer the user\'s question using ONLY the provided context. ' +
          'If the context does not contain enough information, say so clearly.',
      },
      { role: 'user', content: `Context:\n${context}\n\nQuestion: ${prompt}` },
    ];

    const groqResp = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: GROQ_MODEL, messages, max_tokens: 1024 }),
    });
    if (!groqResp.ok) return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: `Groq API returned HTTP ${groqResp.status}.` }) };

    const data   = await groqResp.json();
    const answer = data.choices[0].message.content;

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ response: answer }) };
  } catch (err) {
    console.error('rag_query error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
