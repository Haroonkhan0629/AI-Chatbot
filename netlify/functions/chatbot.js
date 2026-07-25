/**
 * Netlify Function — POST /.netlify/functions/chatbot
 *
 * Receives { prompt, history } and returns { response } using the Groq API.
 * Pure Node.js — no npm packages required (uses built-in fetch, available in Node 18+).
 *
 * Required Netlify environment variable:
 *   GROQ_API_KEY — https://console.groq.com/keys
 */

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL   = "llama-3.3-70b-versatile";
const MAX_TOKENS   = 1024;

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

exports.handler = async function (event) {
  // Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    const { prompt, history = [] } = JSON.parse(event.body || "{}");

    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) {
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Server configuration error: GROQ_API_KEY missing." }),
      };
    }

    const messages = [
      { role: "system", content: "You are a helpful assistant." },
      ...history.map(m => ({ role: m.role, content: m.content })),
      { role: "user", content: prompt },
    ];

    const groqResp = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${groqKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: GROQ_MODEL, messages, max_tokens: MAX_TOKENS }),
    });

    if (!groqResp.ok) {
      return {
        statusCode: 502,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: `Groq API returned HTTP ${groqResp.status}.` }),
      };
    }

    const data  = await groqResp.json();
    const reply = data.choices[0].message.content;

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ response: reply }),
    };
  } catch (err) {
    console.error("chatbot error:", err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
