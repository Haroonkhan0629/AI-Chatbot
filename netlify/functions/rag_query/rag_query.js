/**
 * Netlify Function -- POST /.netlify/functions/rag_query
 *
 * Body: { prompt, docId }. Embeds the prompt, retrieves the top semantic chunks
 * for that document from ChromaDB, and sends only those chunks to Groq.
 * Document ingestion (chunking/embedding/storing) happens beforehand in
 * rag_ingest-background, so this path is just 1 embed + 1 query + 1 LLM call.
 *
 * Retrieval is in rag_shared/rag.js; the answer comes from a direct call to Groq.
 *
 * Env: GROQ_API_KEY, HUGGINGFACE_API_KEY, and CHROMA_URL (self-hosted) or
 * CHROMA_API_KEY + CHROMA_TENANT + CHROMA_DATABASE (Chroma Cloud)
 */

'use strict';

const { findRelevantChunks } = require('../rag_shared/rag');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL   = 'openai/gpt-oss-120b';
const TOP_K        = 5;

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const SYSTEM_PROMPT = `You are a helpful assistant. Answer the user's question using ONLY the provided document excerpts. If they do not contain enough information to answer, say so clearly.

Think step by step before answering. Use exactly this format:
Reasoning: <short step-by-step reasoning that cites the relevant excerpts>
Answer: <final answer for the user>

Example 1
Excerpts:
Q3 revenue was $4.2M, up from $3.5M in Q2.
---
Operating costs in Q3 were $3.0M.

Question: What was the Q3 operating profit?
Reasoning: 1) Q3 revenue is $4.2M. 2) Q3 operating costs are $3.0M. 3) Profit = revenue - costs = $4.2M - $3.0M = $1.2M.
Answer: The Q3 operating profit was $1.2M ($4.2M revenue minus $3.0M operating costs).

Example 2
Excerpts:
The warranty covers manufacturing defects for 24 months from purchase.
---
Accidental damage is not covered.

Question: Is a cracked screen from a drop covered after 6 months?
Reasoning: 1) The warranty is 24 months, so 6 months is within the period. 2) A drop is accidental damage. 3) The excerpts say accidental damage is not covered.
Answer: No. Although it is within the 24-month warranty, accidental damage such as a drop is not covered.

Example 3
Excerpts:
The study enrolled 120 participants across three sites.

Question: What was the dropout rate?
Reasoning: 1) The excerpts give the enrollment count (120). 2) They do not mention dropouts or completion numbers. 3) The rate cannot be derived.
Answer: The document does not contain enough information to determine the dropout rate. It only states that 120 participants were enrolled.`;

// Return only the final answer; fall back to the full text if the model skips the format.
const finalAnswer = text => {
  const i = text.lastIndexOf('Answer:');
  return i === -1 ? text.trim() : text.slice(i + 'Answer:'.length).trim();
};

const reply = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  try {
    const { prompt, docId } = JSON.parse(event.body || '{}');

    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) return reply(500, { error: 'GROQ_API_KEY not configured.' });
    if (!prompt)  return reply(400, { error: 'prompt is required.' });
    if (!docId)   return reply(400, { error: 'docId is required.' });

    const chunks = await findRelevantChunks(docId, prompt, TOP_K);
    if (!chunks.length) return reply(404, { error: 'No indexed content found for this document.' });

    const groqResp = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + groqKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: GROQ_MODEL,
        max_tokens: 1024,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: 'Excerpts:\n' + chunks.join('\n---\n') + '\n\nQuestion: ' + prompt },
        ],
      }),
    });
    if (!groqResp.ok) return reply(502, { error: 'Groq API returned HTTP ' + groqResp.status + '.' });

    const data = await groqResp.json();
    return reply(200, { response: finalAnswer(data.choices[0].message.content) });
  } catch (err) {
    console.error('rag_query error:', err);
    return reply(500, { error: err.message });
  }
};
