"""Application-facing orchestration for use by the CLI, agents, and future UI."""

from dataclasses import dataclass
from pathlib import Path

from sentence_transformers import SentenceTransformer

from .config import (
    DEFAULT_CHUNK_OVERLAP_TOKENS,
    DEFAULT_CHUNK_SIZE_TOKENS,
    DEFAULT_DOCUMENT_DIR,
    DEFAULT_LLM_MODEL,
    DEFAULT_MANIFEST_PATH,
    EMBEDDING_MODEL_NAME,
)
from .generation import generate_grounded_answer
from .ingestion import build_chunks, load_documents
from .models import Chunk, Document, InMemoryVectorStore, SearchResult
from .retrieval import build_vector_store, retrieve


@dataclass(frozen=True)
class Answer:
    """Structured result suitable for serialization by a UI or API."""

    query: str
    text: str
    sources: list[SearchResult]


class FitCoachService:
    """Own the initialized RAG pipeline and expose a small application API."""

    def __init__(
        self,
        document_dir: Path = DEFAULT_DOCUMENT_DIR,
        manifest_path: Path = DEFAULT_MANIFEST_PATH,
        embedding_model_name: str = EMBEDDING_MODEL_NAME,
        chunk_size: int = DEFAULT_CHUNK_SIZE_TOKENS,
        overlap: int = DEFAULT_CHUNK_OVERLAP_TOKENS,
    ) -> None:
        self.document_dir = document_dir
        self.manifest_path = manifest_path
        self.embedding_model_name = embedding_model_name
        self.chunk_size = chunk_size
        self.overlap = overlap
        self.model: SentenceTransformer | None = None
        self.documents: list[Document] = []
        self.chunks: list[Chunk] = []
        self.vector_store: InMemoryVectorStore | None = None

    def initialize(self) -> "FitCoachService":
        self.model = SentenceTransformer(self.embedding_model_name)
        self.documents = load_documents(self.document_dir, self.manifest_path)
        self.chunks = build_chunks(
            self.documents, self.model.tokenizer, self.chunk_size, self.overlap
        )
        self.vector_store = build_vector_store(self.chunks, self.model)
        return self

    def search(
        self, query: str, mode: str = "hybrid", top_k: int = 5
    ) -> list[SearchResult]:
        model, store = self._require_initialized()
        return retrieve(query, store, model, mode, top_k)

    def answer(
        self,
        query: str,
        mode: str = "hybrid",
        top_k: int = 5,
        llm_model: str = DEFAULT_LLM_MODEL,
    ) -> Answer:
        sources = self.search(query, mode, top_k)
        text = generate_grounded_answer(query, sources, llm_model)
        return Answer(query=query, text=text, sources=sources)

    def _require_initialized(
        self,
    ) -> tuple[SentenceTransformer, InMemoryVectorStore]:
        if self.model is None or self.vector_store is None:
            raise RuntimeError("Call initialize() before searching or answering")
        return self.model, self.vector_store
