# LLM Application Chatbot

A publicly deployed AI chatbot with a browser-based interface, powered by Meta's Llama 3.3 70B model via the Groq API and hosted on Netlify. Supports standard multi-turn conversation as well as **Retrieval-Augmented Generation (RAG)** — upload a PDF and the chatbot answers questions grounded in its content. The entire backend is written in Python using FastAPI serverless functions with a SQLModel ORM database layer.

**Live app:** [https://ai-powered-chat.netlify.app/](https://ai-powered-chat.netlify.app/)

## Screenshots

> Add screenshots to a `screenshots/` folder in this repo, then update the paths below.

![Chatbot interface](screenshots/chatbot.png)

## Tools and Technologies Used

### Deployed Version (Netlify)

- JavaScript (ES6+) — frontend
- Python 3.11 — all serverless functions
- FastAPI — request/response handling and Pydantic data serialisation
- Mangum — ASGI adapter bridging FastAPI to Netlify / AWS Lambda events
- Pydantic — request and response model validation
- SQLModel — ORM layer for database operations (built on SQLAlchemy + Pydantic)
- Groq API — LLM inference (Llama 3.3 70B)
- HuggingFace Inference API — sentence embeddings (`all-MiniLM-L6-v2`)
- PostgreSQL (Neon / Supabase) — persistent storage of PDF chunks and embeddings
- pypdf — PDF text extraction
- NumPy — cosine similarity ranking
- Netlify — hosting and serverless function runtime

### Local Development Version

- Python 3.10+
- FastAPI + Uvicorn — local ASGI server
- python-dotenv — `.env` file loading
- sentence-transformers — local embedding model (no HuggingFace API calls)
- SQLite — zero-config local database (no PostgreSQL setup required)
- SQLModel — same ORM used in production, works with SQLite out of the box

### General

- HTML5 / CSS3
- Git and GitHub
- VS Code

## Key Features

- Publicly accessible browser-based chatbot interface
- **PDF RAG pipeline** — upload a PDF, ask questions about it; answers are grounded in the document's content
- Fully Python serverless backend — all three functions (chat, upload, RAG query) are FastAPI apps
- Pydantic models enforce a strict serialisation contract between frontend and backend
- SQLModel ORM manages all database reads and writes; no raw SQL except for similarity ranking
- Embeddings stored as JSON text — compatible with both SQLite (local) and PostgreSQL (deployed), no pgvector extension required
- Cosine similarity ranking done in Python with NumPy
- Multi-turn conversation memory (last 10 exchanges sent with each request)
- API keys secured server-side, never exposed to the browser
- Environment-aware frontend — automatically routes to local FastAPI server or Netlify functions based on hostname

## How It Works

### Regular Chat

`script.js` detects whether the page is served from `localhost` and picks the correct API base path. It sends the user's message and conversation history as a POST request to the chatbot backend, which calls the Groq API and returns the AI reply.

### PDF RAG Pipeline

| Step | What happens |
|---|---|
| **1. Upload** | Browser reads the PDF as base64 and POSTs it to `upload_pdf` |
| **2. Extract** | `pypdf` extracts all page text server-side |
| **3. Chunk** | Text is split into 500-character overlapping windows |
| **4. Embed** | Each chunk is embedded by `sentence-transformers/all-MiniLM-L6-v2` |
| **5. Store** | Chunks and embeddings are persisted to the database via the SQLModel ORM |
| **6. ID returned** | The browser stores only a short UUID — no embeddings ever reach the client |
| **7. Query** | User types a question; browser POSTs `{ prompt, pdf_id }` to `rag_query` |
| **8. Retrieve** | The query is embedded; all stored chunks for that PDF are loaded via ORM and ranked by NumPy cosine similarity |
| **9. Answer** | The top 3 chunks are injected as context into a Groq LLM prompt and the answer is returned |

### Backend comparison

| | Deployed (Netlify) | Local Development |
|---|---|---|
| **Chat backend** | `netlify/functions/chatbot.py` | `main.py` → same handler |
| **Upload backend** | `netlify/functions/upload_pdf.py` | `main.py` → same handler |
| **RAG backend** | `netlify/functions/rag_query.py` | `main.py` → same handler |
| **Framework** | FastAPI + Mangum | FastAPI + Uvicorn |
| **Embeddings** | HuggingFace Inference API | sentence-transformers (local) |
| **Database** | PostgreSQL (Neon / Supabase) | SQLite (`local_vectors.db`) |
| **LLM** | Groq API (Llama 3.3 70B) | Groq API (same) |

## Deploying to Netlify (Public)

### Prerequisites

- A [Groq API key](https://console.groq.com) (free account)
- A free PostgreSQL database — [neon.tech](https://neon.tech) or [supabase.com](https://supabase.com)
- A free [HuggingFace token](https://huggingface.co/settings/tokens) (read access)
- The project pushed to a GitHub repository

### 1. Get a Groq API Key

- Go to [console.groq.com](https://console.groq.com) → **API Keys** → **Create API Key**
- Copy the key

### 2. Create a PostgreSQL Database

- Sign up at [neon.tech](https://neon.tech) (free tier, no credit card)
- Create a new project and copy the connection string — it looks like:
  `postgresql://user:password@ep-xyz.us-east-2.aws.neon.tech/dbname`

### 3. Get a HuggingFace Token

- Go to [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) → **New token** → read access
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

### 6. Add Environment Variables

In Netlify: **Site configuration** → **Environment variables** → **Add a variable**

| Key | Value |
|---|---|
| `GROQ_API_KEY` | Your Groq API key |
| `DATABASE_URL` | Your PostgreSQL connection string |
| `HUGGINGFACE_API_KEY` | Your HuggingFace token |

Trigger a new deploy after saving: **Deploys** → **Trigger deploy** → **Deploy site**

### 7. Open the Live App

Your site will be live at the URL shown on the Netlify dashboard. Open it in any browser and start chatting.

---

## Running Locally

### Prerequisites

- Git
- Python 3.10+
- pip

### 1. Clone the Repository

```bash
git clone <your-repository-url>
cd LLM_application_chatbot
```

### 2. Create and Activate a Virtual Environment

Windows PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

macOS/Linux:

```bash
python -m venv .venv
source .venv/bin/activate
```

### 3. Install Python Dependencies

```bash
pip install -r requirements.txt
```

> `sentence-transformers` pulls in PyTorch (~800 MB on first install). This is a one-time download.

### 4. Create a `.env` File

```bash
cp .env.example .env
```

Open `.env` and set at minimum:

```
GROQ_API_KEY=gsk_your_key_here
DATABASE_URL=sqlite:///./local_vectors.db
```

`HUGGINGFACE_API_KEY` is not needed locally — embeddings run through `sentence-transformers` without any API call.

### 5. Start the Server

```bash
uvicorn main:app --reload
```

The app runs at `http://localhost:8000`.

On first startup you will see:

```
✓ Embeddings: local sentence-transformers model (all-MiniLM-L6-v2)
```

The model (~90 MB) is downloaded once and cached locally. Subsequent runs are instant.

### 6. Use the Chatbot

- Open `http://localhost:8000` in your browser
- **Regular chat** — type a message and submit
- **RAG chat** — click **Upload PDF for RAG**, select a PDF (≤ 4 MB), wait for the chunks to be indexed, then ask questions about the document

## API Endpoints

All three endpoints accept and return JSON. Pydantic models enforce the contract.

### `POST /chatbot`

Request:

```json
{
  "prompt": "Your message here",
  "history": [
    { "role": "user", "content": "Previous message" },
    { "role": "assistant", "content": "Previous reply" }
  ]
}
```

Response:

```json
{ "response": "Model output text" }
```

### `POST /upload_pdf`

Request:

```json
{
  "filename": "document.pdf",
  "file_data": "<base64-encoded PDF bytes>"
}
```

Response:

```json
{ "pdf_id": "550e8400-e29b-41d4-a716-446655440000", "count": 142 }
```

### `POST /rag_query`

Request:

```json
{
  "prompt": "What does the document say about X?",
  "pdf_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

Response:

```json
{ "response": "According to the document, X means..." }
```

## Troubleshooting

### Deployed Version (Netlify)

- **Chatbot returns a 401 error**
  - Confirm `GROQ_API_KEY` is set correctly in Netlify → Environment variables
  - After changing the key, trigger a new deploy
- **PDF upload returns a 502 error**
  - Confirm `HUGGINGFACE_API_KEY` is set — without it, the free-tier inference API is heavily rate-limited
  - Confirm `DATABASE_URL` is set to a valid PostgreSQL connection string
- **Function not found (404)**
  - Confirm `netlify.toml` has `functions = "netlify/functions"`
  - Confirm `netlify/functions/requirements.txt` exists
- **Site loads but sends no messages**
  - Open browser DevTools (F12) → Console for error details

### Local Version (Uvicorn)

- **`GROQ_API_KEY` 401 error**
  - Check `.env` has a valid key and restart the server (`--reload` does not pick up `.env` changes automatically — stop and rerun `uvicorn main:app --reload`)
- **PDF upload DNS error (HuggingFace unreachable)**
  - Ensure `sentence-transformers` is installed — local dev should never call the HuggingFace API
  - If missing: `pip install sentence-transformers`
- **Database error on PDF upload or query**
  - Confirm `.env` has `DATABASE_URL=sqlite:///./local_vectors.db`
  - Delete `local_vectors.db` if the schema is stale, then restart
- **Server does not start**
  - Ensure the virtual environment is activated
  - Run `pip install -r requirements.txt` again

## Project Structure

```text
LLM_application_chatbot/
├── index.html              # Static frontend served by Netlify / Uvicorn
├── main.py                 # Local FastAPI dev server (mounts all function handlers)
├── netlify.toml            # Netlify build config (Python 3.11, functions dir)
├── requirements.txt        # Local dev dependencies
├── .env.example            # Template for environment variables
├── Dockerfile              # Optional containerised setup
├── netlify/
│   └── functions/
│       ├── chatbot.py      # Serverless function — standard chat via Groq
│       ├── upload_pdf.py   # Serverless function — PDF ingest + embedding
│       ├── rag_query.py    # Serverless function — semantic search + RAG answer
│       ├── db.py           # Shared SQLModel schema and engine factory
│       └── requirements.txt  # Serverless function dependencies
└── static/
    ├── script.js           # Frontend logic (environment-aware API routing)
    └── css/
        └── style.css
```

## Summary

Built a publicly deployed AI chatbot with full PDF-based Retrieval-Augmented Generation (RAG). The backend is entirely Python, using FastAPI for request serialisation via Pydantic models, SQLModel as the ORM for all database operations, and Mangum to adapt the ASGI apps to Netlify's serverless function format. Uploaded PDFs are chunked, embedded with `sentence-transformers/all-MiniLM-L6-v2`, and stored in a database; queries retrieve the most relevant chunks by cosine similarity before passing them as context to the Llama 3.3 70B model via Groq. Local development uses SQLite and runs embeddings in-process — no external database or API keys required beyond Groq.

