/**
 * Netlify Function — POST /.netlify/functions/rag_query
 *
 * Fetches text chunks for the given pdf_id, ranks them with keyword (TF-IDF)
 * scoring against the user's query, then generates an answer via Groq.
 * No external embedding API is required — retrieval is pure JS, < 1 s.
 *
 * Returns { response }.
 *
 * Required Netlify environment variables:
 *   DATABASE_URL — PostgreSQL connection string (Neon / Supabase / etc.)
 *   GROQ_API_KEY — from https://console.groq.com/keys
 */

'use strict';

const { Client } = require('pg');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL   = 'llama-3.3-70b-versatile';
const TOP_K        = 4;

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ---------------------------------------------------------------------------
// Keyword-based retrieval (TF-IDF style, pure JS, no external API)
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
  return score / Math.sqrt(words.length); // length-normalise
}

async function retrieveChunks(pdfId, query) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const { rows } = await client.query(
      'SELECT chunk_text FROM pdf_chunks WHERE pdf_id = $1',
      [pdfId]
    );
    if (!rows.length) return [];
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

    const chunks  = await retrieveChunks(pdf_id, prompt);
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
