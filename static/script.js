// Store conversation history for multi-turn context
let savedpasttext = []; // Variable to store user messages
let savedpastresponse = []; // Variable to store bot responses
const conversationHistory = []; // Sent to backend for context-aware responses

// Route API calls:
//   localhost / 127.0.0.1  → relative path e.g. /chatbot        (local uvicorn)
//   everywhere else         → Netlify Functions e.g. /.netlify/functions/chatbot
const _isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const apiUrl = path => _isLocal ? path : `/.netlify/functions${path}`;

// RAG state — UUID returned by upload_pdf and stored server-side in PostgreSQL
let currentPdfText = null;

// Get references to main UI elements
const messagesContainer = document.getElementById('messages-container');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');
const pdfInput = document.getElementById('pdf-input');
const pdfStatus = document.getElementById('pdf-status');
const clearPdfBtn = document.getElementById('clear-pdf-btn');


// ---------------------------------------------------------------------------
// PDF upload handling — text is extracted IN THE BROWSER via PDF.js CDN so
// the Netlify function never needs a server-side PDF library.
// ---------------------------------------------------------------------------

/** Lazily load PDF.js from CDN and return the pdfjsLib global. */
async function getPdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/static/pdf.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load PDF.js from /static/pdf.min.js'));
    document.head.appendChild(s);
  });
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/static/pdf.worker.min.js';
  return window.pdfjsLib;
}

/** Extract all text from a PDF File object using PDF.js (browser-side). */
async function extractPdfText(file) {
  const pdfjsLib   = await getPdfJs();
  const arrayBuf   = await file.arrayBuffer();
  const pdf        = await pdfjsLib.getDocument({ data: arrayBuf }).promise;
  const parts      = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page    = await pdf.getPage(i);
    const content = await page.getTextContent();
    parts.push(content.items.map(item => item.str || '').join(' '));
  }
  await pdf.destroy();
  return parts.join('\n');
}

pdfInput.addEventListener('change', async () => {
  const file = pdfInput.files[0];
  if (!file) return;

  pdfStatus.textContent = '⏳ Extracting text from PDF…';
  pdfStatus.className = 'pdf-status loading';
  clearPdfBtn.style.display = 'none';
  currentPdfText = null;

  try {
    const text = await extractPdfText(file);
    if (!text.trim()) {
      pdfStatus.textContent = '❌ No text found. Is this a scanned / image-only PDF?';
      pdfStatus.className = 'pdf-status error';
      pdfInput.value = '';
      return;
    }
    currentPdfText = text;
    pdfStatus.textContent = `✅ ${file.name} — ready`;
    pdfStatus.className = 'pdf-status success';
    clearPdfBtn.style.display = 'inline-block';
  } catch (err) {
    console.error('PDF extract error:', err);
    const msg = (err instanceof Error) ? err.message : 'Failed to read PDF.';
    pdfStatus.textContent = `❌ ${msg}`;
    pdfStatus.className = 'pdf-status error';
  }

  // Reset so the same file can be re-uploaded after clearing
  pdfInput.value = '';
});

clearPdfBtn.addEventListener('click', () => {
  currentPdfText = null;
  pdfStatus.textContent = '';
  pdfStatus.className = 'pdf-status';
  clearPdfBtn.style.display = 'none';
});


// ---------------------------------------------------------------------------
// RAG query (PDF path)
// ---------------------------------------------------------------------------

async function makeRAGRequest(message) {
  try {
    const resp = await fetch(apiUrl('/rag_query'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Only the prompt and UUID are sent — all embeddings are retrieved from the DB
      body: JSON.stringify({ prompt: message, pdfText: currentPdfText }),
    });
    return await resp.json();
  } catch (err) {
    console.error('RAG request error:', err);
    return { error: err.message };
  }
}


// ---------------------------------------------------------------------------
// Standard chat (no PDF) — calls the Netlify function
// ---------------------------------------------------------------------------

async function makePostRequest(msg) {
  const url = apiUrl('/chatbot');
  const requestBody = { prompt: msg, history: conversationHistory };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    const data = await response.json();
    console.log(data);
    return data;
  } catch (error) {
    console.error('Error:', error);
    return { error: error.message };
  }
}


// ---------------------------------------------------------------------------
// Display a message bubble in the chat window
// ---------------------------------------------------------------------------

const addMessage = (message, role, imgSrc) => {
  const messageElement = document.createElement('div');
  const textElement = document.createElement('div');
  messageElement.className = `message ${role}`;
  const imgElement = document.createElement('img');
  imgElement.src = imgSrc;
  messageElement.appendChild(imgElement);
  if (role === 'aibot') {
    textElement.innerHTML = marked.parse(message);
  } else {
    textElement.innerText = message;
  }
  messageElement.appendChild(textElement);
  messagesContainer.appendChild(messageElement);
  const clearDiv = document.createElement('div');
  clearDiv.style.clear = 'both';
  messagesContainer.appendChild(clearDiv);
};


// ---------------------------------------------------------------------------
// Send a message — branches on whether a PDF is loaded
// ---------------------------------------------------------------------------

const sendMessage = async (message) => {
  addMessage(message, 'user', '../static/user.jpeg');

  // Loading animation
  const loadingElement = document.createElement('div');
  const loadingtextElement = document.createElement('p');
  loadingElement.className = 'loading-animation';
  loadingtextElement.className = 'loading-text';
  loadingtextElement.innerText = currentPdfText
    ? 'Searching PDF context… please wait'
    : 'Loading....Please wait';
  messagesContainer.appendChild(loadingElement);
  messagesContainer.appendChild(loadingtextElement);

  // If a PDF is loaded use RAG, otherwise use the standard chatbot endpoint
  const data = currentPdfText
    ? await makeRAGRequest(message)
    : await makePostRequest(message);

  // Remove loading animation
  document.querySelector('.loading-animation')?.remove();
  document.querySelector('.loading-text')?.remove();

  // Display response or error
  if (data.error) {
    addMessage(JSON.stringify(data), 'error', '../static/Error.png');
  } else {
    addMessage(data['response'], 'aibot', '../static/Bot_logo.png');
  }

  // Persist to conversation history (standard path only — RAG is stateless per query)
  if (!data.error && !currentPdfText) {
    conversationHistory.push({ role: 'user', content: message });
    conversationHistory.push({ role: 'assistant', content: data['response'] });
    if (conversationHistory.length > 20) conversationHistory.splice(0, 2);
  }
};


// ---------------------------------------------------------------------------
// Form submit handler
// ---------------------------------------------------------------------------

messageForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = messageInput.value.trim();
  if (message !== '') {
    messageInput.value = '';
    await sendMessage(message);
  }
});

