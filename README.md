# FitCoachGPT

FitCoachGPT is a small Retrieval-Augmented Generation (RAG) application that answers fitness questions using a corpus of scientific papers about resistance training, hypertrophy, nutrition, supplements, concurrent training, and recovery.

The project keeps all chunks, embeddings, and retrieval indexes in memory and uses a local Ollama model for grounded answer generation and evaluation.

## Pipeline

```text
PDF papers
  -> page-by-page text extraction
  -> sentence-aware chunks
  -> dense embeddings + BM25 index
  -> hybrid retrieval with Reciprocal Rank Fusion
  -> retrieved context added to the prompt
  -> grounded Ollama answer with citations
```

## Features

- Loads 10 PDF papers with `pypdf`
- Preserves source URLs and PDF page numbers
- Creates sentence-aware chunks targeting 300 MPNet tokens
- Uses approximately 25 tokens of overlap
- Embeds chunks with `sentence-transformers/all-mpnet-base-v2`
- Stores normalized 768-dimensional vectors in memory
- Supports dense, BM25, and hybrid retrieval
- Combines dense and BM25 rankings with Reciprocal Rank Fusion
- Generates cited answers with local `llama3.2` through Ollama
- Abstains when the retrieved evidence does not support an answer
- Evaluates Hit Rate@K, MRR, Faithfulness, Answer Relevance, and Context Relevance

## Requirements

- Python 3.10 or newer
- [Ollama](https://ollama.com/)
- The `llama3.2` Ollama model

## Setup

Create and activate a virtual environment:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Download and start the Ollama model:

```bash
ollama pull llama3.2
ollama serve
```

The embedding model is downloaded automatically the first time the application runs.

## Ask a Question

Hybrid retrieval is the default:

```bash
python fit_coach_gpt.py \
  --query "Does creatine improve high-intensity exercise performance?"
```

Choose a retrieval strategy or change the number of returned chunks:

```bash
python fit_coach_gpt.py \
  --retrieval bm25 \
  --top-k 5 \
  --query "How much protein should an exercising person consume?"
```

Valid retrieval modes are `dense`, `bm25`, and `hybrid`.

## Corpus and Chunking

PDFs are stored in `data/documents/`. Source metadata is stored in `data/manifest.csv` and matched by exact PDF filename.

Each PDF is extracted page by page. The chunker uses the MPNet tokenizer to create chunks of up to 300 model tokens with approximately 25 tokens of sentence-level overlap. Each chunk retains its document ID, title, source URL, year, topics, and page range.

The current corpus produces 972 chunks. Their normalized `float32` embedding matrix has shape `(972, 768)` and uses approximately 2.85 MB of memory.

## Retrieval

Dense retrieval embeds the question with MPNet and computes cosine similarity using a dot product against the normalized chunk embeddings.

BM25 retrieval performs keyword-based sparse search. Hybrid retrieval obtains candidates from both methods and combines their ranks using Reciprocal Rank Fusion:

```text
RRF score = sum(1 / (60 + rank))
```

This combination helps with both semantic questions and exact fitness terminology.

## Grounded Generation

The five highest-ranked chunks are labeled `[S1]` through `[S5]` and injected into the Ollama prompt. The model is instructed to answer only from this evidence and cite supported claims.

Answers without a valid retrieved-source citation are replaced with:

```text
I do not have enough evidence in the provided sources.
```

FitCoachGPT provides educational fitness information and is not a medical diagnosis or treatment system.

## Evaluation

The evaluation dataset is `data/eval_dataset.json`. It contains 10 corpus-specific questions with labeled relevant document IDs.

Run the evaluation with:

```bash
python fit_coach_gpt.py --evaluate --top-k 5
```

Detailed per-question answers, retrieved IDs, and scores are saved to `data/evaluation_results.json`.

### Metrics

- **Hit Rate@K:** whether at least one relevant document appears in the top K results
- **MRR:** reciprocal rank of the first relevant document
- **Faithfulness:** whether answer claims are supported by retrieved context
- **Answer Relevance:** whether the answer directly addresses the question
- **Context Relevance:** whether the retrieved chunks are useful for the question

Retrieval metrics use the labeled document IDs. The three generation metrics use `llama3.2` as an LLM judge with scores from 0.0 to 1.0.

### Current Results

The following results were produced with hybrid retrieval at K=5 over all 10 evaluation questions:

| Metric | Score |
|---|---:|
| Hit Rate@5 | 1.000 |
| MRR | 1.000 |
| Faithfulness | 0.640 |
| Answer Relevance | 0.660 |
| Context Relevance | 0.720 |

Retrieval found a relevant paper at rank 1 for every evaluation question. Two questions retrieved the correct paper but produced the insufficient-evidence response, reducing the generation scores. This suggests that future improvement should focus on selecting more answer-bearing chunks and improving generation reliability rather than document-level retrieval.

LLM-judged metrics may vary slightly between runs, even with temperature set to zero.

## Project Files

```text
fit_coach_gpt.py             Main ingestion, retrieval, generation, and evaluation code
requirements.txt             Python dependencies
data/documents/              PDF corpus
data/manifest.csv            Source metadata
data/eval_dataset.json       Evaluation questions and relevance labels
data/evaluation_results.json Detailed evaluation output
```
