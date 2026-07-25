"""
Netlify serverless function — POST /.netlify/functions/chatbot

Regular (non-RAG) chat endpoint.  Receives a user message and conversation
history, forwards them to the Groq LLM, and streams back the reply.

FastAPI handles request/response serialisation via Pydantic models.
Mangum adapts the ASGI app to the AWS Lambda / Netlify Functions event format.

Required Netlify environment variable:
  GROQ_API_KEY  — https://console.groq.com/keys
"""

from __future__ import annotations

import os

import requests
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from mangum import Mangum
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Pydantic models — enforced serialisation contract between frontend & backend
# ---------------------------------------------------------------------------

class HistoryMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    prompt: str
    history: list[HistoryMessage] = []


class ChatResponse(BaseModel):
    response: str


class ErrorResponse(BaseModel):
    error: str


# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL   = "llama-3.3-70b-versatile"
MAX_TOKENS   = 1024

app = FastAPI(title="Chatbot Function")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.api_route("/{full_path:path}", methods=["POST"])
async def chat(request: Request) -> JSONResponse:
    """Accept a user message, call Groq, return the AI reply."""
    try:
        body = await request.json()
        req  = ChatRequest.model_validate(body)

        groq_key = os.environ.get("GROQ_API_KEY")
        if not groq_key:
            return JSONResponse(
                status_code=500,
                content=ErrorResponse(error="Server configuration error: GROQ_API_KEY missing.").model_dump(),
            )

        messages = [
            {"role": "system", "content": "You are a helpful assistant."},
            *[m.model_dump() for m in req.history],
            {"role": "user", "content": req.prompt},
        ]

        groq_resp = requests.post(
            GROQ_API_URL,
            headers={"Authorization": f"Bearer {groq_key}", "Content-Type": "application/json"},
            json={"model": GROQ_MODEL, "messages": messages, "max_tokens": MAX_TOKENS},
            timeout=30,
        )
        groq_resp.raise_for_status()

        reply = groq_resp.json()["choices"][0]["message"]["content"]
        return JSONResponse(content=ChatResponse(response=reply).model_dump())

    except requests.exceptions.HTTPError as exc:
        code = exc.response.status_code if exc.response is not None else 502
        return JSONResponse(
            status_code=502,
            content=ErrorResponse(error=f"Groq API returned HTTP {code}.").model_dump(),
        )
    except Exception as exc:
        print(f"chatbot error: {exc}")
        return JSONResponse(
            status_code=500,
            content=ErrorResponse(error=str(exc)).model_dump(),
        )


# ---------------------------------------------------------------------------
# Mangum — bridges ASGI ↔ Netlify / AWS Lambda event format
# ---------------------------------------------------------------------------

handler = Mangum(app, lifespan="off")
