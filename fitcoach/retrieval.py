"""In-memory dense, sparse, and hybrid retrieval."""

import re

import numpy as np
from rank_bm25 import BM25Okapi
from sentence_transformers import SentenceTransformer

from .config import EMBEDDING_MODEL_NAME, RRF_K
from .models import Chunk, InMemoryVectorStore, SearchResult


def tokenize_for_bm25(text: str) -> list[str]:
    return re.findall(r"\b\w+\b", text.lower())


def build_vector_store(
    chunks: list[Chunk], model: SentenceTransformer
) -> InMemoryVectorStore:
    embeddings = model.encode(
        [chunk.text for chunk in chunks],
        batch_size=32,
        convert_to_numpy=True,
        normalize_embeddings=True,
        show_progress_bar=True,
    )
    return InMemoryVectorStore(
        chunks=chunks,
        embeddings=embeddings,
        bm25=BM25Okapi([tokenize_for_bm25(chunk.text) for chunk in chunks]),
        model_name=EMBEDDING_MODEL_NAME,
    )


def validate_search(query: str, top_k: int) -> None:
    if not query.strip():
        raise ValueError("Query cannot be empty")
    if top_k <= 0:
        raise ValueError("top_k must be greater than zero")


def retrieve_dense(
    query: str,
    vector_store: InMemoryVectorStore,
    model: SentenceTransformer,
    top_k: int = 5,
) -> list[SearchResult]:
    validate_search(query, top_k)
    query_embedding = model.encode(
        query, convert_to_numpy=True, normalize_embeddings=True
    )
    scores = vector_store.embeddings @ query_embedding
    indices = np.argsort(scores)[::-1][:top_k]
    return [(vector_store.chunks[i], float(scores[i])) for i in indices]


def retrieve_bm25(
    query: str, vector_store: InMemoryVectorStore, top_k: int = 5
) -> list[SearchResult]:
    validate_search(query, top_k)
    scores = vector_store.bm25.get_scores(tokenize_for_bm25(query))
    indices = np.argsort(scores)[::-1][:top_k]
    return [(vector_store.chunks[i], float(scores[i])) for i in indices]


def retrieve_hybrid(
    query: str,
    vector_store: InMemoryVectorStore,
    model: SentenceTransformer,
    top_k: int = 5,
) -> list[SearchResult]:
    validate_search(query, top_k)
    candidate_k = min(len(vector_store.chunks), max(top_k * 4, 20))
    rankings = (
        retrieve_dense(query, vector_store, model, candidate_k),
        retrieve_bm25(query, vector_store, candidate_k),
    )
    chunk_indices = {
        chunk.chunk_id: index for index, chunk in enumerate(vector_store.chunks)
    }
    fused_scores: dict[int, float] = {}
    for ranked_results in rankings:
        for rank, (chunk, _) in enumerate(ranked_results, start=1):
            index = chunk_indices[chunk.chunk_id]
            fused_scores[index] = fused_scores.get(index, 0.0) + 1.0 / (
                RRF_K + rank
            )
    indices = sorted(fused_scores, key=fused_scores.get, reverse=True)[:top_k]
    return [(vector_store.chunks[i], fused_scores[i]) for i in indices]


def retrieve(
    query: str,
    vector_store: InMemoryVectorStore,
    model: SentenceTransformer,
    mode: str = "hybrid",
    top_k: int = 5,
) -> list[SearchResult]:
    """Dispatch retrieval through one stable interface for UIs and agents."""

    if mode == "dense":
        return retrieve_dense(query, vector_store, model, top_k)
    if mode == "bm25":
        return retrieve_bm25(query, vector_store, top_k)
    if mode == "hybrid":
        return retrieve_hybrid(query, vector_store, model, top_k)
    raise ValueError(f"Unknown retrieval mode: {mode}")


# Backward-readable aliases used by the original single-file implementation.
retrieve_chunks = retrieve_dense
retrieve_bm25_chunks = retrieve_bm25
retrieve_hybrid_chunks = retrieve_hybrid
