# OpenClaw SiYuan Plugin

OpenClaw Gateway plugin for SiYuan note-taking integration with intelligent memory recall and content routing.

## Features

### ✅ Implemented

- **Memory Recall**: Automatically retrieve relevant notes before AI responds
  - Intent analysis with keyword extraction
  - Multi-path search (full-text + SQL + local FTS)
  - Context aggregation and relevance scoring
  - Token-budget-aware formatting

- **Intelligent Routing**: 4-layer routing decision engine
  - Explicit user commands detection
  - Rule-based keyword matching
  - Context-aware document association
  - Inbox fallback

- **Content Write System**: Smart conversation persistence
  - Multiple capture strategies (smart, last_turn, full_session)
  - Content filtering (greeting detection, length checks)
  - Template-based formatting (daily note, append, inbox)
  - Deduplication

- **SiYuan API Integration**: Complete API coverage
  - Health monitoring
  - Block and document operations
  - Full-text search and SQL queries
  - Custom attributes

- **Local Index System**: SQLite FTS5 for fast offline search
  - Automatic initial sync on first run
  - Incremental background sync (configurable interval)
  - FTS5 full-text indexing
  - Document registry with metadata
  - Cleanup of deleted documents

## Architecture

Simple and clear structure:

```
src/
├── services/        # Business logic and application services
└── clients/         # External API clients and integrations
```

## Installation

```bash
pnpm install
```

## Configuration

Create one of the following config files (first match wins):

- `./openclaw.config.json` (recommended for project-local config)
- `./openclaw.json`
- `~/.openclaw/openclaw.config.json`
- `~/.openclaw/openclaw.json` (legacy default)

```json
{
  "siyuan": {
    "apiUrl": "http://127.0.0.1:6806",
    "apiToken": "your-api-token"
  },
  "routing": {
    "rules": []
  }
}
```

## Memory Recall (How It Works)

The recall flow is **multi-path search + two-stage retrieval (recall wide, then re-rank) + context formatting** (implemented in `src/services/memory-recall.js`).

- **Trigger**: runs on `before_agent_start` when:
  - `recall.enabled=true`
  - SiYuan is available (health check OK)
  - `prompt.length >= recall.minPromptLength`
  - and the prompt is **not** greeting/small-talk (e.g. "你好呀，最近怎么样？")
  - and the prompt does **not** include an explicit skip phrase (e.g. "不用回忆/不要检索/不用查笔记")
- **Intent analysis**: keyword extraction + optional time range detection + intent type.
- **Search paths (default)**: controlled by `recall.searchPaths` (default: `["fulltext","sql","fts"]`). Each enabled path returns candidates:
  - `fts` (Local SQLite FTS5) first, **only if** local index is enabled and initialized (`index.enabled=true` and `indexManager` available)
  - `fulltext` (SiYuan API full-text search)
  - `sql` (SiYuan API SQL query; **time range filter currently only applies here** via `updated > since`)
- **Two-stage retrieval**:
  - Stage 1 (candidate recall): pull more results per path (higher recall)
  - Stage 2 (re-rank + diversity): normalize fields, score blocks for relevance, then cap per-document blocks to avoid one doc dominating
- **Context formatting**: groups blocks by document and formats top documents into a token-budget-aware `<siyuan_context>...</siyuan_context>` block.

Tip: if you want to force a single strategy, set `recall.searchPaths` to just one of `["fts"]`, `["fulltext"]`, or `["sql"]`.

### Memory Recall Configuration

Two-stage retrieval is enabled by default. You can tune it like this:

```json
{
  "recall": {
    "maxKeywords": 12,
    "twoStage": {
      "enabled": true,
      "candidateLimitPerPath": 120,
      "finalBlockLimit": 40,
      "perDocBlockCap": 6,
      "fulltextOptions": {
        "sort": 0
      }
    }
  }
}
```

- `recall.maxKeywords`: maximum extracted keywords used for scoring/SQL fallback (keeps noisy prompts from exploding query terms).
- `recall.twoStage.candidateLimitPerPath`: stage-1 candidate limit for each enabled search path.
- `recall.twoStage.finalBlockLimit`: final number of blocks returned after re-ranking.
- `recall.twoStage.perDocBlockCap`: max blocks kept per document (diversity cap).
- `recall.twoStage.fulltextOptions`: extra options forwarded to SiYuan `/api/search/fullTextSearchBlock`.

## Development

```bash
# Run tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Lint code
pnpm lint

# Run linter with auto-fix
pnpm lint:fix
```

## Test Coverage

- **109 tests passing** ✅
- Configuration management: 14 tests
- SiYuan API client: 13 tests
- Routing engine: 21 tests
- Content writer: 19 tests
- Memory recall: 17 tests
- Index manager: 17 tests
- Plugin lifecycle: 8 tests

## Project Structure

```
src/
├── services/            # Business services
│   ├── content-writer.js      # Content persistence
│   ├── memory-recall.js       # Memory retrieval
│   └── routing-engine.js      # Routing decisions
├── clients/             # External integrations
│   ├── config.js              # Configuration management
│   ├── siyuan-client.js       # SiYuan API client
│   └── index-manager.js       # Local SQLite FTS index
└── index.js             # Plugin entry point
```

## Documentation

- [DESIGN.md](./DESIGN.md) - Complete design document with lifecycle flows and architecture details

## Contributing

This project follows Test-Driven Development (TDD) principles. All new features should include comprehensive unit tests.

## License

MIT
