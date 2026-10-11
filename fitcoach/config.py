"""Shared defaults for the FitCoachGPT pipeline."""

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DOCUMENT_DIR = PROJECT_ROOT / "data" / "documents"
DEFAULT_MANIFEST_PATH = PROJECT_ROOT / "data" / "manifest.csv"
DEFAULT_EVAL_DATASET_PATH = PROJECT_ROOT / "data" / "eval_dataset.json"
DEFAULT_EVAL_OUTPUT_PATH = PROJECT_ROOT / "data" / "evaluation_results.json"

DEFAULT_CHUNK_SIZE_TOKENS = 300
DEFAULT_CHUNK_OVERLAP_TOKENS = 25
EMBEDDING_MODEL_NAME = "sentence-transformers/all-mpnet-base-v2"
RRF_K = 60

OLLAMA_BASE_URL = "http://localhost:11434"
DEFAULT_LLM_MODEL = "llama3.2"
ABSTENTION_RESPONSE = "I do not have enough evidence in the provided sources."
