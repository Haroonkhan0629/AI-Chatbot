"""
Shared database module — imported by all three Netlify Python functions.

Schema
------
pdf_chunks table  :  one row per text chunk from an uploaded PDF.
                     Embeddings are stored as JSON text so the same schema
                     works with both SQLite (local dev) and PostgreSQL
                     (Neon / Supabase on Netlify) — no pgvector extension
                     required.  Cosine-distance ranking is done in Python.

Environment variable
--------------------
DATABASE_URL  :  SQLite  →  sqlite:///./local_vectors.db   (local dev default)
                 Postgres →  postgresql://user:pass@host/db  (Netlify / Neon)
"""

from __future__ import annotations

import os
from typing import Optional

from sqlalchemy.pool import NullPool, StaticPool
from sqlmodel import Field, SQLModel, create_engine


class PDFChunk(SQLModel, table=True):
    """One overlapping text chunk from an uploaded PDF plus its embedding."""

    __tablename__ = "pdf_chunks"

    id: Optional[int] = Field(default=None, primary_key=True)
    # Groups every chunk that belongs to a single upload session
    pdf_id: str = Field(index=True)
    chunk_text: str
    # JSON-serialised list[float] — compatible with SQLite and PostgreSQL
    embedding: str


def get_engine():
    """
    Return an engine appropriate for the configured database backend.

    SQLite   → default pool (fine for file-based databases, zero config)
    Postgres → NullPool (no persistent connections — safe for serverless)
    """
    url = os.environ.get("DATABASE_URL", "sqlite:///./local_vectors.db")
    if url.startswith("sqlite"):
        return create_engine(url, connect_args={"check_same_thread": False},
                             poolclass=StaticPool)
    return create_engine(url, poolclass=NullPool)


def ensure_schema(engine) -> None:
    """Create tables if they do not yet exist (idempotent)."""
    SQLModel.metadata.create_all(engine)
