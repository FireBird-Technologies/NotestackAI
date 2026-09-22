"""Embeddings through LiteLLM. Always requests EMBEDDING_DIM so the pgvector column stays fixed."""

from dataclasses import dataclass

import litellm

from app.config import settings

BATCH = 64


@dataclass
class EmbeddingResult:
    vectors: list[list[float]]
    tokens: int


def embed_texts(texts: list[str]) -> EmbeddingResult:
    vectors: list[list[float]] = []
    tokens = 0
    for i in range(0, len(texts), BATCH):
        batch = [t[:8000] for t in texts[i : i + BATCH]]
        resp = litellm.embedding(
            model=settings.embedding_model,
            input=batch,
            api_base=settings.embedding_api_base or None,
            api_key=settings.embedding_api_key or None,
            dimensions=settings.embedding_dim,
        )
        vectors.extend(item["embedding"] for item in resp.data)
        tokens += int(getattr(resp, "usage", None) and resp.usage.prompt_tokens or 0)
    for v in vectors:
        if len(v) != settings.embedding_dim:
            raise ValueError(
                f"Embedding model returned {len(v)} dims, expected {settings.embedding_dim}. "
                "Check EMBEDDING_MODEL supports the dimensions parameter."
            )
    return EmbeddingResult(vectors=vectors, tokens=tokens)


def embedding_provider() -> str:
    return settings.embedding_model.split("/", 1)[0]


def embed_query(text: str) -> list[float]:
    return embed_texts([text]).vectors[0]
