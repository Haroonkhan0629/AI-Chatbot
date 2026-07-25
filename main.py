"""
Local development server.

Reuses the exact same FastAPI handler functions that run as Netlify serverless
functions in production — no code duplication.

Setup:
  1. cp .env.example .env  and fill in your keys
  2. pip install -r requirements.txt
  3. uvicorn main:app --reload
  4. Open http://localhost:8000
"""

import sys
from pathlib import Path

from dotenv import load_dotenv

# Load .env before the function modules are imported, because they read
# environment variables at call time via os.environ.get(...)
load_dotenv()

# Make `from db import ...` work when the function files are imported below
sys.path.insert(0, str(Path(__file__).parent / "netlify" / "functions"))

import chatbot as chatbot_mod        # noqa: E402 (intentional late import)
import upload_pdf as upload_pdf_mod  # noqa: E402
import rag_query as rag_query_mod    # noqa: E402

# ---------------------------------------------------------------------------
# Local embedding override
#
# On Netlify the functions call the HuggingFace Inference API for embeddings.
# Locally that endpoint is often unreachable (DNS / firewall).  If
# sentence-transformers is installed we run the model in-process instead,
# which is faster and requires no internet after the first model download.
# ---------------------------------------------------------------------------

try:
    from sentence_transformers import SentenceTransformer as _ST

    _st_model = _ST("all-MiniLM-L6-v2")  # cached in ~/.cache after first run

    def _local_embed_batch(texts: list[str], api_key: str = "") -> list[list[float]]:
        return _st_model.encode(texts, convert_to_numpy=True).tolist()

    def _local_embed_query(text_: str, api_key: str = "") -> list[float]:
        return _st_model.encode([text_], convert_to_numpy=True)[0].tolist()

    # Monkey-patch the module globals so the route handlers pick up the
    # local functions without any changes to the serverless function files.
    upload_pdf_mod.embed_batch = _local_embed_batch
    rag_query_mod.embed_query  = _local_embed_query

    print("✓ Embeddings: local sentence-transformers model (all-MiniLM-L6-v2)")

except ImportError:
    print("⚠ sentence-transformers not installed — will use HuggingFace Inference API")

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="LLM Chatbot — Local Dev")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# API routes — delegate directly to the serverless function handlers
# ---------------------------------------------------------------------------

@app.post("/chatbot")
async def chatbot_route(request: Request):
    return await chatbot_mod.chat(request)


@app.post("/upload_pdf")
async def upload_pdf_route(request: Request):
    return await upload_pdf_mod.upload_pdf(request)


@app.post("/rag_query")
async def rag_query_route(request: Request):
    return await rag_query_mod.rag_query(request)


# ---------------------------------------------------------------------------
# Static files and root HTML
# ---------------------------------------------------------------------------

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def root():
    return FileResponse("index.html")
