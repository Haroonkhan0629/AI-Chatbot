/**
 * Netlify Function -- GET /.netlify/functions/chroma_warmup
 *
 * Pinged by the browser on page load so a sleeping self-hosted Chroma server
 * (e.g. Render free tier) starts waking up before the user needs it.
 * Any HTTP response from the server means it is awake; we only wait ~8 s
 * because the wake-up continues on Render even if we stop waiting.
 */
'use strict';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

exports.handler = async function () {
  if (!process.env.CHROMA_URL) return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'not-needed' }) };

  try {
    await fetch(process.env.CHROMA_URL.replace(/\/$/, '') + '/api/v2/heartbeat', {
      signal: AbortSignal.timeout(8000),
    });
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'awake' }) };
  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'waking' }) };
  }
};
