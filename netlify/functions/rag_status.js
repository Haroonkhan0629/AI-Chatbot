/** GET /.netlify/functions/rag_status?docId=... -> { status: 'processing' | 'ready' | 'error' } */
'use strict';

const { getIndexStatus } = require('./rag_shared/rag');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async function (event) {
  const docId = event.queryStringParameters && event.queryStringParameters.docId;
  if (!docId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'docId is required.' }) };
  try {
    const status = await getIndexStatus(docId);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ status }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
