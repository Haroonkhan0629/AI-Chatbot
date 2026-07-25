"""
Netlify serverless function — POST /.netlify/functions/upload_pdf

Accepts a PDF (base64-encoded JSON payload), extracts its text, splits it into
overlapping chunks, generates sentence embeddings via the HuggingFace Inference
API, and persists every chunk + embedding to PostgreSQL via the SQLModel ORM.

Returns a short { pdf_id, count } payload; the browser stores only the UUID and
sends it with subsequent RAG queries — no embeddings ever transit the browser.

Required Netlify environment variables:
  DATABASE_URL         — PostgreSQL connection string (Neon / Supabase)
  HUGGINGFACE_API_KEY  — free read token from huggingface.co/settings/tokens
"""

from __future__ import annotations

import base64
import io
import json
import math
import os
import uuid

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from mangum import Mangum
from pypdf import PdfReader
from pydantic import BaseModel
from sqlalchemy.pool import NullPool, StaticPool
from sqlmodel import Field, Session, SQLModel, create_engine
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

class PDFUploadRequest(BaseModel):
    filename: str
    file_data: str          # base64-encoded raw PDF bytes


class PDFUploadResponse(BaseModel):
    pdf_id: str             # UUID that identifies this upload in the database
    count: int              # number of chunks stored


class ErrorResponse(BaseModel):
    error: str


# ---------------------------------------------------------------------------
# Processing constants
# ---------------------------------------------------------------------------

HF_MODEL      = "sentence-transformers/all-MiniLM-L6-v2"
CHUNK_SIZE    = 500
CHUNK_OVERLAP = 50
MAX_PDF_BYTES = 4 * 1024 * 1024   # 4 MB — safely within Netlify's 6 MB body limit
EMBED_BATCH   = 32                 # texts per HuggingFace API call


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def split_into_chunks(text: str) -> list[str]:
    chunks, start = [], 0
    while start < len(text):
        chunk = text[start : start + CHUNK_SIZE]
        if chunk.strip():
            chunks.append(chunk)
        start += CHUNK_SIZE - CHUNK_OVERLAP
    return chunks


def embed_batch(texts: list[str], api_key: str) -> list[list[float]]:
    """
    Embed a batch of texts via the HuggingFace Inference Providers API.
    Uses huggingface_hub.InferenceClient which routes through the new
    router.huggingface.co infrastructure (not the deprecated api-inference host).
    """
    from huggingface_hub import InferenceClient
    client = InferenceClient(provider="hf-inference", token=api_key)
    result = client.feature_extraction(texts, model=HF_MODEL)
    # InferenceClient returns an ndarray of shape (n_texts, dim) for sentence-transformers
    if hasattr(result, "tolist"):
        return result.tolist()
    return [[float(x) for x in emb] for emb in result]


# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

app = FastAPI(title="Upload PDF Function")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.api_route("/{full_path:path}", methods=["POST"])
async def upload_pdf(request: Request) -> JSONResponse:
    """Chunk and embed a PDF, persist to PostgreSQL, return the pdf_id."""
    import os
    try:
        body = await request.json()
        req  = PDFUploadRequest.model_validate(body)

        # --- validate & decode PDF ---
        if not req.filename.lower().endswith(".pdf"):
            return JSONResponse(status_code=400, content=ErrorResponse(error="Please upload a PDF file.").model_dump())

        pdf_bytes = base64.b64decode(req.file_data)

        if not pdf_bytes.startswith(b"%PDF"):
            return JSONResponse(status_code=400, content=ErrorResponse(error="File does not appear to be a valid PDF.").model_dump())

        if len(pdf_bytes) > MAX_PDF_BYTES:
            return JSONResponse(status_code=400, content=ErrorResponse(error="File exceeds the 4 MB size limit.").model_dump())

        # --- extract text ---
        reader    = PdfReader(io.BytesIO(pdf_bytes))
        full_text = "\n".join(page.extract_text() or "" for page in reader.pages)

        if not full_text.strip():
            return JSONResponse(status_code=400, content=ErrorResponse(error="Could not extract text from this PDF.").model_dump())

        # --- chunk ---
        chunks = split_into_chunks(full_text)

        # --- embed in batches ---
        hf_key = os.environ.get("HUGGINGFACE_API_KEY", "")
        all_embeddings: list[list[float]] = []
        for i in range(0, len(chunks), EMBED_BATCH):
            all_embeddings.extend(embed_batch(chunks[i : i + EMBED_BATCH], hf_key))

        # --- persist to PostgreSQL/SQLite via SQLModel ORM ---
        engine   = get_engine()
        ensure_schema(engine)
        pdf_id   = str(uuid.uuid4())

        with Session(engine) as session:
            for chunk_text, embedding in zip(chunks, all_embeddings):
                session.add(PDFChunk(
                    pdf_id=pdf_id,
                    chunk_text=chunk_text,
                    embedding=json.dumps(embedding),   # serialise list[float] → TEXT
                ))
            session.commit()

        return JSONResponse(
            content=PDFUploadResponse(pdf_id=pdf_id, count=len(chunks)).model_dump()
        )

    except requests.exceptions.HTTPError as exc:
        code = exc.response.status_code if exc.response is not None else 502
        return JSONResponse(status_code=502, content=ErrorResponse(error=f"HuggingFace API returned HTTP {code}.").model_dump())
    except Exception as exc:
        print(f"upload_pdf error: {exc}")
        return JSONResponse(status_code=500, content=ErrorResponse(error=str(exc)).model_dump())


# ---------------------------------------------------------------------------
# Mangum — bridges ASGI ↔ Netlify / AWS Lambda event format
# ---------------------------------------------------------------------------

handler = Mangum(app, lifespan="off")
