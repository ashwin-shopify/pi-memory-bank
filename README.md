# memory-bank

Persistent memory bank for [pi](https://github.com/mariozechner/pi). Stores active projects, daily context, knowledge files, and session history across sessions. Context is injected on-demand via `/recall` — never automatically.

## Install

```bash
pi install git:github.com/ashwin-shopify/pi-memory-bank
```

## How it works

**Storage** (`~/.pi/memory/`):
- `core/activeProjects.md` — active work and priorities
- `core/dailyContext.md` — today's session log, decisions, carry-forward
- `knowledge/*.md` — persistent reference docs, conventions, decisions
- `history/daily/YYYY-MM/` — archived daily contexts

**On session start:**
- Archives yesterday's `dailyContext.md` to history when the date rolls over
- Carries forward "Context for Tomorrow" into the new day
- Builds a full-text search index (BM25 via MiniSearch) over all `.md` files

**On `/recall`:**
- Injects `activeProjects.md` and `dailyContext.md` into the conversation
- Optionally searches knowledge and history for a given query

**Throughout the session:**
- The agent uses tools to write completed work, decisions, and knowledge files
- Prompt guidelines teach the agent concise logging, proactive knowledge capture, and self-verification

## Commands

| Command | Description |
|---------|-------------|
| `/recall` | Inject activeProjects + dailyContext into conversation |
| `/recall <query>` | Also search and inject matching knowledge/history |
| `/memory` | Show memory bank status (file counts, index size) |

## Tools

| Tool | Description |
|------|-------------|
| `memory_read` | Read any file from the memory bank |
| `memory_update` | Write a file (creates dirs, updates search index) |
| `memory_append` | Append text to a named section in a file |
| `memory_search` | BM25 fuzzy search across all memory files |
| `memory_list` | List files in the memory bank |

## Configuration

Override the memory bank location with the `PI_MEMORY_DIR` environment variable.
