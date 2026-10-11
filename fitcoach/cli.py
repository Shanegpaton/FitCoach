"""Command-line interface for FitCoachGPT."""

import argparse
from pathlib import Path

from .config import (
    DEFAULT_CHUNK_OVERLAP_TOKENS,
    DEFAULT_CHUNK_SIZE_TOKENS,
    DEFAULT_DOCUMENT_DIR,
    DEFAULT_EVAL_DATASET_PATH,
    DEFAULT_EVAL_OUTPUT_PATH,
    DEFAULT_LLM_MODEL,
    EMBEDDING_MODEL_NAME,
)
from .evaluation import run_evaluation
from .generation import generate_grounded_answer
from .reporting import (
    print_embedding_report,
    print_grounded_answer,
    print_ingestion_report,
    print_retrieval_results,
)
from .service import FitCoachService


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="FitCoachGPT RAG pipeline")
    parser.add_argument("--document-dir", type=Path, default=DEFAULT_DOCUMENT_DIR)
    parser.add_argument("--chunk-size", type=int, default=DEFAULT_CHUNK_SIZE_TOKENS)
    parser.add_argument("--overlap", type=int, default=DEFAULT_CHUNK_OVERLAP_TOKENS)
    parser.add_argument(
        "--query",
        default="Does creatine improve strength and exercise performance?",
    )
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument(
        "--retrieval", choices=("dense", "bm25", "hybrid"), default="hybrid"
    )
    parser.add_argument("--model", default=DEFAULT_LLM_MODEL)
    parser.add_argument("--evaluate", action="store_true")
    parser.add_argument(
        "--eval-dataset", type=Path, default=DEFAULT_EVAL_DATASET_PATH
    )
    parser.add_argument("--eval-output", type=Path, default=DEFAULT_EVAL_OUTPUT_PATH)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    print(f"Loading embedding model: {EMBEDDING_MODEL_NAME}")
    service = FitCoachService(
        document_dir=args.document_dir,
        chunk_size=args.chunk_size,
        overlap=args.overlap,
    ).initialize()
    model, vector_store = service._require_initialized()
    print_ingestion_report(service.documents, service.chunks, model.tokenizer)
    print_embedding_report(vector_store)

    if args.evaluate:
        run_evaluation(
            vector_store,
            model,
            args.eval_dataset,
            args.eval_output,
            args.top_k,
            args.model,
        )
        return

    results = service.search(args.query, args.retrieval, args.top_k)
    print_retrieval_results(args.query, results, args.retrieval)
    answer = generate_grounded_answer(args.query, results, args.model)
    print_grounded_answer(answer)
