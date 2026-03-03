# Python Bridge

This directory contains the optional Python bridge server that provides:

- **LangGraph agent execution** — multi-step ReAct agents with tool use
- **Mem0 memory** — persistent long-term memory per user
- **ChromaDB vector search** — semantic context retrieval

## Setup

```bash
cd pakalon-cli/python
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# Optional: full agent mode
pip install langgraph langchain-openai mem0ai chromadb
```

## Running

The bridge is automatically started by the CLI when agent mode is used.
To run manually:

```bash
python bridge/server.py --port 7432
```

## Health check

```bash
curl http://127.0.0.1:7432/health
```
