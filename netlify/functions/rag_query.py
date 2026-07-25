"""
Netlify serverless function — POST /.netlify/functions/rag_query

Embeds the user's query via HuggingFace (or local sentence-transformers),
loads matching chunks from the database via the SQLModel ORM, ranks them with
Python cosine similarity, injects the top results as context into a Groq LLM
prompt, and returns the answer.

The browser only sends { prompt, pdf_id } — all heavyweight data (embeddings,
chunk text) lives in the database, never in the browser after upload.

Required Netlify environment variables:
  DATABASE_URL         — sqlite:///./local_vectors.db  (local) or Postgres URL
  GROQ_API_KEY         — https://console.groq.com/keys
  HUGGINGFACE_API_KEY  — free read token from huggingface.co/settings/tokens
"""

from __future__ import annotations

import json
import os

import numpy as np
import requests
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from mangum import Mangum
from pydantic import BaseModel
from sqlalchemy.pool import NullPool, StaticPool
from sqlmodel import Field, Session, SQLModel, create_engine, select
from typing import Optional


# ---------------------------------------------------------------------------
# Database schema (inlined from db.py so this file is self-contained)
# ---------------------------------------------------------------------------

class PDFChunk(SQLModel, table=True):
    __tablename__ = "pdf_chunks"
    __table_args__ = {"extend_existing": True}
    id: Optional[int] = Field(default=None, primary_key=True)
    pdf_id: str = Field(index=True)
    chunk_text: str
    embedding: str  # JSON-serialised list[float]


def get_engine():
    url = os.environ.get("DATABASE_URL", "sqlite:///./local_vectors.db")
    if url.startswith("sqlite"):
        return create_engine(url, connect_args={"check_same_thread": False}, poolclass=StaticPool)
    # pg8000 is a pure-Python driver — rewrite the URL dialect if needed
    if not url.startswith("postgresql+"):
        url = url.replace("postgres://", "postgresql+pg8000://", 1)
        url = url.replace("postgresql://", "postgresql+pg8000://", 1)
    return create_engine(url, poolclass=NullPool)


def ensure_schema(engine):
    SQLModel.metadata.create_all(engine)

# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class RAGRequest(BaseModel):
    prompt: str
    pdf_id: str             # UUID returned by upload_pdf and stored in the browser


class RAGResponse(BaseModel):
    response: str


class ErrorResponse(BaseModel):
    error: str


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

HF_MODEL     = "sentence-transformers/all-MiniLM-L6-v2"
HF_API_URL   = f"https://api-inference.huggingface.co/pipeline/feature-extraction/{HF_MODEL}"
GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL   = "llama-3.3-70b-versatile"
TOP_K        = 3
MAX_TOKENS   = 1024


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def embed_query(text_: str, api_key: str) -> list[float]:
    """Return a single 384-dimensional embedding for the user's query."""
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    resp = requests.post(
        HF_API_URL,
        headers=headers,
        json={"inputs": [text_], "options": {"wait_for_model": True}},
        timeout=45,
    )
    resp.raise_for_status()
    raw = resp.json()[0]

    arr = np.array(raw, dtype=np.float32)
    if arr.ndim > 1:
        arr = arr.mean(axis=0)
    return arr.tolist()


def retrieve_chunks(pdf_id: str, query_embedding: list[float], engine, top_k: int = TOP_K) -> list[str]:
    """
    Fetch all stored chunks for this pdf_id via the SQLModel ORM, then rank
    them by cosine similarity in Python.  Works with both SQLite and PostgreSQL
    without requiring the pgvector extension.
    """
    with Session(engine) as session:
        rows = session.exec(
            select(PDFChunk).where(PDFChunk.pdf_id == pdf_id)
        ).all()

    if not rows:
        return []

    q = np.array(query_embedding, dtype=np.float32)
    q_norm = np.linalg.norm(q)

    scored: list[tuple[float, str]] = []
    for row in rows:
        e = np.array(json.loads(row.embedding), dtype=np.float32)
        e_norm = np.linalg.norm(e)
        sim = float(np.dot(q, e) / (q_norm * e_norm)) if q_norm and e_norm else 0.0
        scored.append((sim, row.chunk_text))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [text for _, text in scored[:top_k]]


# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

app = FastAPI(title="RAG Query Function")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.api_route("/{full_path:path}", methods=["POST"])
async def rag_query(request: Request) -> JSONResponse:
    """Embed query → retrieve context via ORM → answer with Groq LLM."""
    try:
        body = await request.json()
        req  = RAGRequest.model_validate(body)

        hf_key   = os.environ.get("HUGGINGFACE_API_KEY", "")
        groq_key = os.environ.get("GROQ_API_KEY")

        if not groq_key:
            return JSONResponse(
                status_code=500,
                content=ErrorResponse(error="Server configuration error: GROQ_API_KEY missing.").model_dump(),
            )

        # 1. Embed the user's query
        query_vec = embed_query(req.prompt, hf_key)

# 2. Retrieve top-k most similar chunks from the database
        engine = get_engine()
        ensure_schema(engine)
        context_chunks = retrieve_chunks(req.pdf_id, query_vec, engine)

        if not context_chunks:
            return JSONResponse(
                status_code=404,
                content=ErrorResponse(error="No PDF data found for this ID. Please re-upload the PDF.").model_dump(),
            )

        context = "\n\n".join(context_chunks)

        # 3. Build RAG prompt and call Groq
        messages = [
            {
                "role": "system",
                "content": (
                    "You are a helpful assistant. Use only the context below — extracted "
                    "from a PDF document — to answer the user's question. If the answer "
                    "is not contained in the context, say so honestly.\n\n"
                    f"Context:\n{context}"
                ),
            },
            {"role": "user", "content": req.prompt},
        ]

        groq_resp = requests.post(
            GROQ_API_URL,
            headers={"Authorization": f"Bearer {groq_key}", "Content-Type": "application/json"},
            json={"model": GROQ_MODEL, "messages": messages, "max_tokens": MAX_TOKENS},
            timeout=30,
        )
        groq_resp.raise_for_status()

        answer = groq_resp.json()["choices"][0]["message"]["content"].strip()
        return JSONResponse(content=RAGResponse(response=answer).model_dump())

    except requests.exceptions.HTTPError as exc:
        code = exc.response.status_code if exc.response is not None else 502
        return JSONResponse(
            status_code=502,
            content=ErrorResponse(error=f"Upstream API returned HTTP {code}.").model_dump(),
        )
    except Exception as exc:
        print(f"rag_query error: {exc}")
        return JSONResponse(
            status_code=500,
            content=ErrorResponse(error=str(exc)).model_dump(),
        )


# ---------------------------------------------------------------------------
# Mangum — bridges ASGI ↔ Netlify / AWS Lambda event format
# ---------------------------------------------------------------------------

handler = Mangum(app, lifespan="off")
