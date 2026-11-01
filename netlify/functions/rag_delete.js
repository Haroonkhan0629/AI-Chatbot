/** POST /.netlify/functions/rag_delete  { docId } -> removes that document's chunks from Chroma */
'use strict';

const { deleteDocument } = require('./rag_shared/rag');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only.' }) };
  let docId;
  try { docId = JSON.parse(event.body || '{}').docId; } catch (e) { /* handled below */ }
  if (!docId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'docId is required.' }) };
  try {
    await deleteDocument(docId);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ deleted: true }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
