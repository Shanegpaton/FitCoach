"""Human-readable CLI reporting."""

from .ingestion import token_count
from .models import Chunk, Document, InMemoryVectorStore, SearchResult


def print_ingestion_report(
    documents: list[Document], chunks: list[Chunk], tokenizer
) -> None:
    print("FitCoachGPT ingestion report")
    print("=" * 60)
    print(f"Documents loaded: {len(documents)}")
    print(f"Chunks created:  {len(chunks)}")
    print()
    for document in documents:
        document_chunks = [
            chunk for chunk in chunks if chunk.document_id == document.document_id
        ]
        counts = [token_count(chunk.text, tokenizer) for chunk in document_chunks]
        average = sum(counts) / len(counts) if counts else 0
        token_range = f"{min(counts)}-{max(counts)}" if counts else "n/a"
        print(f"- {document.filename}")
        print(f"  title: {document.title}")
        print(f"  pages with text: {len(document.pages)}")
        print(
            f"  chunks: {len(document_chunks)} | token range: {token_range} "
            f"| average: {average:.1f}"
        )
        print(f"  source: {document.source_url}")
    if chunks:
        example = chunks[0]
        preview = example.text[:300] + ("..." if len(example.text) > 300 else "")
        print("\nExample chunk")
        print("-" * 60)
        print(f"ID: {example.chunk_id}")
        print(f"Title: {example.title}")
        print(f"Pages: {example.page_start}-{example.page_end}")
        print(f"Text: {preview}")


def print_embedding_report(vector_store: InMemoryVectorStore) -> None:
    rows, dimensions = vector_store.embeddings.shape
    print("\nEmbedding report")
    print("=" * 60)
    print(f"Model: {vector_store.model_name}")
    print(f"Vectors: {rows}")
    print(f"Dimensions: {dimensions}")
    print(f"Data type: {vector_store.embeddings.dtype}")
    print(f"Memory used: {vector_store.embeddings.nbytes / (1024 * 1024):.2f} MB")
    print("BM25 index: ready")


def print_retrieval_results(
    query: str, results: list[SearchResult], retrieval_mode: str
) -> None:
    print(f"\n{retrieval_mode.title()} retrieval results")
    print("=" * 60)
    print(f"Query: {query}")
    for rank, (chunk, score) in enumerate(results, start=1):
        preview = chunk.text[:300] + ("..." if len(chunk.text) > 300 else "")
        print(f"\n{rank}. score={score:.4f} | {chunk.title}")
        print(f"   chunk: {chunk.chunk_id}")
        print(f"   pages: {chunk.page_start}-{chunk.page_end}")
        print(f"   source: {chunk.source_url}")
        print(f"   text: {preview}")


def print_grounded_answer(answer: str) -> None:
    print("\nGrounded answer")
    print("=" * 60)
    print(answer)
