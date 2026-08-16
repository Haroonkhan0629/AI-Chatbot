/**
 * Netlify Function — POST /.netlify/functions/chatbot
 * Pure Node.js, zero npm dependencies (uses built-in fetch, available Node 18+).
 */

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL   = 'openai/gpt-oss-120b';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { prompt, history = [] } = JSON.parse(event.body || '{}');
    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'GROQ_API_KEY not configured.' }) };

    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      ...history.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: prompt },
    ];

    const resp = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: GROQ_MODEL, messages, max_tokens: 1024 }),
    });
    if (!resp.ok) return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: `Groq API returned HTTP ${resp.status}.` }) };

    const data  = await resp.json();
    const reply = data.choices[0].message.content;
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ response: reply }) };
  } catch (err) {
    console.error('chatbot error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
