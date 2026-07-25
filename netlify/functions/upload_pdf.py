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
import uuid

import numpy as np
import requests
from db import PDFChunk, ensure_schema, get_engine
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from mangum import Mangum
from pypdf import PdfReader
from pydantic import BaseModel
from sqlmodel import Session

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
HF_API_URL    = f"https://api-inference.huggingface.co/pipeline/feature-extraction/{HF_MODEL}"
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
    Call HuggingFace feature-extraction pipeline for a batch of texts.
    Mean-pools token embeddings to produce one sentence vector per text.
    """
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    resp = requests.post(
        HF_API_URL,
        headers=headers,
        json={"inputs": texts, "options": {"wait_for_model": True}},
        timeout=45,
    )
    resp.raise_for_status()
    raw = resp.json()

    embeddings: list[list[float]] = []
    for vec in raw:
        arr = np.array(vec, dtype=np.float32)
        if arr.ndim > 1:            # token-level → sentence-level via mean pooling
            arr = arr.mean(axis=0)
        embeddings.append(arr.tolist())
    return embeddings


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
