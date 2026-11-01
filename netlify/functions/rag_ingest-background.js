/**
 * Netlify BACKGROUND function -- POST /.netlify/functions/rag_ingest-background
 *
 * The "-background" suffix makes Netlify return 202 immediately and let this run
 * for up to 15 minutes, so the slow indexing is not bound by the 10 s limit.
 * The browser polls rag_status to learn when it has finished.
 *
 * Body: { docId, text }
 */
'use strict';

const { indexDocument } = require('./rag_shared/rag');

exports.handler = async function (event) {
  const { docId, text } = JSON.parse(event.body || '{}');
  if (!docId || !text) return { statusCode: 400 };

  await indexDocument(docId, text);
  return { statusCode: 200 };
};
