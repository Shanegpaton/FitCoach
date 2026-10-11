"""Core data models shared across ingestion, retrieval, and generation."""

from dataclasses import dataclass

import numpy as np
from rank_bm25 import BM25Okapi


@dataclass(frozen=True)
class PageText:
    page_number: int
    text: str


@dataclass(frozen=True)
class Document:
    document_id: str
    title: str
    source_url: str
    year: str
    topics: tuple[str, ...]
    filename: str
    pages: tuple[PageText, ...]


@dataclass(frozen=True)
class Chunk:
    chunk_id: str
    document_id: str
    text: str
    title: str
    source_url: str
    year: str
    topics: tuple[str, ...]
    page_start: int
    page_end: int


@dataclass(frozen=True)
class InMemoryVectorStore:
    chunks: list[Chunk]
    embeddings: np.ndarray
    bm25: BM25Okapi
    model_name: str


SearchResult = tuple[Chunk, float]
