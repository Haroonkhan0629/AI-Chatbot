/**
 * Netlify Function -- POST /.netlify/functions/rag_query
 *
 * Receives { prompt, pdfText } where pdfText is already extracted by the
 * browser. No DB, no HuggingFace -- just passes the document text directly
 * to Groq as context. Works within Netlify's 10 s function timeout.
 *
 * Required Netlify environment variables:
 *   GROQ_API_KEY -- from https://console.groq.com/keys
 */

'use strict';

const GROQ_API_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL     = 'openai/gpt-oss-120b';
const MAX_TEXT_CHARS = 80000; // ~60K tokens, well within Groq 128K context limit

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  try {
    const { prompt, pdfText } = JSON.parse(event.body || '{}');

    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey)
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'GROQ_API_KEY not configured.' }) };
    if (!prompt)
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'prompt is required.' }) };
    if (!pdfText)
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'pdfText is required.' }) };

    // Truncate if the document is very large (protects Groq context limit)
    const context = pdfText.length > MAX_TEXT_CHARS
      ? pdfText.slice(0, MAX_TEXT_CHARS) + '\n\n[Document truncated due to length]'
      : pdfText;

    const messages = [
      {
        role: 'system',
        content:
          "You are a helpful assistant. Answer the user's question using ONLY the " +
          'provided document context. If the context does not contain enough ' +
          'information to answer, say so clearly.',
      },
      { role: 'user', content: 'Document:\n' + context + '\n\nQuestion: ' + prompt },
    ];

    const groqResp = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + groqKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: GROQ_MODEL, messages, max_tokens: 1024 }),
    });
    if (!groqResp.ok)
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Groq API returned HTTP ' + groqResp.status + '.' }) };

    const data   = await groqResp.json();
    const answer = data.choices[0].message.content;
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ response: answer }) };
  } catch (err) {
    console.error('rag_query error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
