# FitCoachGPT Project Instructions

## Project Goal

Build a small Retrieval-Augmented Generation (RAG) fitness coach for the CSE 434 lab. The system should answer questions about resistance training, hypertrophy, strength, nutrition, supplements, and recovery using the supplied scientific-source summaries.

This student is in **CSE 434**, not CSE 534. Do not add CSE 534-only requirements unless explicitly requested. In particular, a 20-question custom dataset, two advanced RAG techniques, and a baseline-versus-advanced comparison are not required.

## Keep the Implementation Small

- Keep the main implementation in `fit_coach_gpt.py`, following the style of the course examples.
- Use `data/documents/` for the corpus and `data/manifest.csv` for source metadata.
- Use an in-memory vector store. Do not introduce ChromaDB, a server, a web framework, or a large package structure unless requested.
- Build the project incrementally and explain each major step before moving to the next one.
- Prefer readable educational code over production abstractions.

## RAG Design

- Embedding model: `sentence-transformers/all-MiniLM-L6-v2` unless changed by the user.
- Dense retrieval: normalized embeddings with cosine similarity.
- Advanced RAG technique: hybrid retrieval using dense similarity plus BM25.
- Generation: Ollama, following the course examples, unless changed by the user.
- Retrieve approximately 3-5 final chunks for generation.
- Require grounded answers with source citations and an explicit insufficient-evidence response when appropriate.

## Ingestion and Chunking

- Load `.pdf` papers from `data/documents/`; this corpus is PDF-only.
- Preserve stable document IDs and citation metadata, including title, source, source URL, year, and topics.
- Use sentence-aware chunks targeting approximately **300 model tokens**.
- Use approximately **25 model tokens of overlap** between consecutive chunks from the same document.
- Never combine content from different source documents into one chunk.
- Do not split a short document merely to force it to reach 300 tokens.
- When the embedding model is available, use its tokenizer for token counts. A deterministic estimate is acceptable before that dependency is installed.
- Preserve PDF page numbers in chunk metadata and citations.

## Required CSE 434 Evaluation

The evaluation pipeline must report:

- Hit Rate@K
- Mean Reciprocal Rank (MRR)
- Faithfulness
- Answer Relevance
- Context Relevance

Retrieval metrics should use labeled relevant document or chunk IDs. Generation metrics may use a clearly documented LLM-as-judge prompt. Save detailed per-question results in a machine-readable format and show aggregate results in the README.

## Verification

After each implementation step:

- Run `python3 -m py_compile fit_coach_gpt.py`.
- Run the relevant pipeline command or script behavior.
- Check outputs with representative fitness questions.
- Do not claim that retrieval or evaluation works without executing it.

## Scope and Safety

- Treat the application as an educational fitness information tool, not a medical diagnosis system.
- Ground advice in the retrieved corpus.
- Preserve source URLs so users can trace answers to the underlying references.
- Do not fabricate measurements, workout history, citations, or personalized medical recommendations.
