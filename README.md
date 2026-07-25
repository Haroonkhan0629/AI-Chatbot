# LLM Application Chatbot

A publicly deployed AI chatbot with a browser-based interface, powered by Meta's Llama 3.3 70B model via the Groq API and hosted on Netlify. Supports standard multi-turn conversation as well as **Retrieval-Augmented Generation (RAG)** — upload a PDF and the chatbot answers questions grounded in its content. The entire backend runs as Node.js serverless functions on Netlify.

**Live app:** [https://ai-powered-chat.netlify.app/](https://ai-powered-chat.netlify.app/)

## Screenshots

> Add screenshots to a `screenshots/` folder in this repo, then update the paths below.

![Chatbot interface](screenshots/chatbot.png)

## Tools and Technologies Used

- **Node.js 18** — all serverless functions (chatbot, upload\_pdf, rag\_query)
- **Groq API** — LLM inference (Llama 3.3 70B)
- **HuggingFace Inference Providers API** — sentence embeddings (`all-MiniLM-L6-v2` via `router.huggingface.co`)
- **PostgreSQL** (Neon / Supabase) — persistent storage of PDF chunks and embeddings
- **pg** (npm) — PostgreSQL client with native SSL support
- **pdf-parse** (npm) — server-side PDF text extraction
- **Netlify** — hosting, serverless function runtime, and continuous deployment
- **HTML5 / CSS3 / JavaScript (ES6+)** — frontend
- **Git and GitHub**

## Key Features

- Publicly accessible browser-based chatbot interface
- **PDF RAG pipeline** — upload a PDF, ask questions about it; answers are grounded in the document's content
- Pure Node.js serverless backend — no Python runtime, no custom build steps
- Embeddings stored as JSON text — no pgvector extension required
- Cosine similarity ranking done in pure JavaScript
- Multi-turn conversation memory (last N exchanges sent with each request)
- API keys secured server-side, never exposed to the browser

## How It Works

### Regular Chat

`script.js` sends the user's message and conversation history as a POST request to `/.netlify/functions/chatbot`, which calls the Groq API and returns the AI reply.

### PDF RAG Pipeline

| Step | What happens |
|---|---|
| **1. Upload** | Browser reads the PDF as base64 and POSTs it to `upload_pdf` |
| **2. Extract** | `pdf-parse` extracts all page text server-side |
| **3. Chunk** | Text is split into 500-character overlapping windows |
| **4. Embed** | Each chunk is embedded via HuggingFace Inference Providers (`sentence-transformers/all-MiniLM-L6-v2`) |
| **5. Store** | Chunks and embeddings are persisted to PostgreSQL using the `pg` client |
| **6. ID returned** | The browser stores only a short UUID — no embeddings ever reach the client |
| **7. Query** | User types a question; browser POSTs `{ prompt, pdf_id }` to `rag_query` |
| **8. Retrieve** | The query is embedded; all stored chunks for that PDF are fetched and ranked by cosine similarity in JavaScript |
| **9. Answer** | The top 3 chunks are injected as context into a Groq LLM prompt and the answer is returned |

### Serverless Functions

| File | Route | Purpose |
|---|---|---|
| `netlify/functions/chatbot.js` | `/.netlify/functions/chatbot` | Multi-turn chat via Groq |
| `netlify/functions/upload_pdf/upload_pdf.js` | `/.netlify/functions/upload_pdf` | PDF ingestion, embedding, storage |
| `netlify/functions/rag_query/rag_query.js` | `/.netlify/functions/rag_query` | Query embedding, retrieval, Groq answer |

## Deploying to Netlify

### Prerequisites

- A [Groq API key](https://console.groq.com) (free account)
- A free PostgreSQL database — [neon.tech](https://neon.tech) or [supabase.com](https://supabase.com)
- A free [HuggingFace token](https://huggingface.co/settings/tokens) with **Inference Providers** read access
- The project pushed to a GitHub repository

### 1. Get a Groq API Key

- Go to [console.groq.com](https://console.groq.com) → **API Keys** → **Create API Key**
- Copy the key

### 2. Create a PostgreSQL Database

- Sign up at [neon.tech](https://neon.tech) (free tier, no credit card)
- Create a new project and copy the connection string — it looks like:
  `postgresql://user:password@ep-xyz.us-east-2.aws.neon.tech/dbname`

### 3. Get a HuggingFace Token

- Go to [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) → **New token** → select **Inference Providers** read access
- Copy the token

### 4. Push the Project to GitHub

```bash
git init
git add .
git commit -m "initial commit"
git remote add origin <your-github-repo-url>
git push -u origin main
```

### 5. Connect the Repo to Netlify

- Go to [app.netlify.com](https://app.netlify.com)
- Click **Add new site** → **Import an existing project** → **GitHub**
- Select your repository
- Leave **Build command** blank — `netlify.toml` handles configuration
- Set **Publish directory** to `.`
- Click **Deploy site**

Netlify automatically installs npm packages for the `upload_pdf` and `rag_query` directory functions on every deploy.

### 6. Add Environment Variables

In Netlify: **Site configuration** → **Environment variables** → **Add a variable**

| Key | Value |
|---|---|
| `GROQ_API_KEY` | Your Groq API key |
| `DATABASE_URL` | Your PostgreSQL connection string |
| `HUGGINGFACE_API_KEY` | Your HuggingFace token |

Trigger a new deploy after saving: **Deploys** → **Trigger deploy** → **Deploy site**

### 7. Open the Live App

Your site will be live at the URL shown on the Netlify dashboard.

---

## Running Locally

The easiest way to run the functions locally is with the **Netlify CLI**, which emulates the full Netlify environment including function execution.

### Prerequisites

- Node.js 18+
- npm
- [Netlify CLI](https://docs.netlify.com/cli/get-started/): `npm install -g netlify-cli`

### 1. Clone the Repository

```bash
git clone <your-repository-url>
cd LLM_application_chatbot
```

### 2. Create a `.env` File

```bash
cp .env.example .env
```

Open `.env` and set:

```
GROQ_API_KEY=your_groq_api_key_here
DATABASE_URL=your_postgresql_connection_string_here
HUGGINGFACE_API_KEY=your_huggingface_token_here
```

### 3. Start the Local Dev Server

```bash
netlify dev
```

The app runs at `http://localhost:8888`. Functions are available at `http://localhost:8888/.netlify/functions/<name>`.

---

## API Reference

### `POST /.netlify/functions/chatbot`

```json
// Request
{ "prompt": "Your message", "history": [{ "role": "user", "content": "..." }, { "role": "assistant", "content": "..." }] }

// Response
{ "response": "Model output text" }
```

### `POST /.netlify/functions/upload_pdf`

```json
// Request
{ "filename": "document.pdf", "file_data": "<base64-encoded PDF bytes>" }

// Response
{ "pdf_id": "uuid", "count": 42 }
```

### `POST /.netlify/functions/rag_query`

```json
// Request
{ "prompt": "What does the document say about X?", "pdf_id": "uuid" }

// Response
{ "response": "Based on the document..." }
```



