# Memory Bank (Recall-Only) Implementation Plan

> For agentic workers: REQUIRED: Use subagent-driven-development
> (if subagents available) or executing-plans to implement this plan.

Goal: A pi package that provides persistent memory (write tools, archiving, search) but does NOT inject context into every prompt. Context is only injected on-demand via `/recall`.

Architecture: Fork the shop-pi-fy memory extension into a standalone pi package. Remove the `before_agent_start` hook that injects memory into every prompt. Replace it with a `/recall` command that manually injects the same context (activeProjects + dailyContext + search results) as a one-shot message. Keep all 5 tools (memory_read, memory_update, memory_append, memory_search, memory_list), the `/memory` status command, session_start archiving, and MiniSearch indexing. Drop qmd integration entirely.

Tech Stack: TypeScript, pi extension API (`@mariozechner/pi-coding-agent`), MiniSearch, Vitest

## File Structure

```
~/Code/memory-bank/
├── package.json              — pi package manifest
├── tsconfig.json             — TypeScript config (noEmit, type-checking only)
├── vitest.config.ts          — Test runner config
├── README.md                 — Package docs
├── extensions/
│   └── memory/
│       ├── index.ts          — Main extension (tools, commands, session lifecycle)
│       ├── search.ts         — MiniSearch index (copied from shop-pi-fy, unchanged)
│       └── search.test.ts    — Search tests (copied from shop-pi-fy, unchanged)
└── docs/
    └── plans/
        └── 2026-04-05-memory-bank-plan.md  — This plan
```

## Key Differences from shop-pi-fy memory

| Area | shop-pi-fy memory | memory-bank |
|------|-------------------|-------------|
| `before_agent_start` | Injects activeProjects + dailyContext + search hits every prompt | **Removed entirely** |
| `/recall` command | Does not exist | **New** — injects context on demand via `pi.appendEntry()` |
| `/recall <query>` | N/A | **New** — searches memory and injects matching results |
| qmd integration | Optional semantic search | **Removed** — MiniSearch only |
| `qmd-search.ts` | 250 lines | **Not included** |
| Package type | Part of shop-pi-fy monorepo | **Standalone package** |

## Prerequisite: Disable existing memory extension

Before installing this package, the user must remove the shop-pi-fy memory extension symlink:
```bash
rm ~/.pi/agent/extensions/memory
# Or via /pkg rm memory
```
Then install this package:
```bash
pi install ~/Code/memory-bank
```

---

### Task 1: Package scaffold + search module

**Files:**
- Create: `~/Code/memory-bank/package.json`
- Create: `~/Code/memory-bank/tsconfig.json`
- Create: `~/Code/memory-bank/vitest.config.ts`
- Create: `~/Code/memory-bank/.gitignore`
- Create: `~/Code/memory-bank/extensions/memory/search.ts`
- Create: `~/Code/memory-bank/extensions/memory/search.test.ts`

- [ ] Step 1: Create package.json

```json
{
  "name": "memory-bank",
  "version": "0.1.0",
  "type": "module",
  "description": "Persistent memory bank for pi — recall-only, no auto-injection",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["extensions/memory"]
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@mariozechner/pi-agent-core": "^0.62.0",
    "@mariozechner/pi-ai": "^0.62.0",
    "@mariozechner/pi-coding-agent": "^0.62.0",
    "@mariozechner/pi-tui": "^0.62.0",
    "@sinclair/typebox": "^0.34.48",
    "vitest": "^4.1.0"
  },
  "dependencies": {
    "minisearch": "^7.2.0"
  }
}
```

- [ ] Step 2: Create tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["extensions/**/*.ts"],
  "exclude": ["node_modules", "**/*.test.ts"]
}
```

- [ ] Step 3: Create vitest.config.ts

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["extensions/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
  },
});
```

- [ ] Step 4: Create .gitignore

```
node_modules/
```

- [ ] Step 5: Copy search.ts from shop-pi-fy (unchanged)

Copy `~/.pi/agent/git/github.com/shopify-playground/shop-pi-fy/extensions/memory/search.ts` to `~/Code/memory-bank/extensions/memory/search.ts` verbatim.

- [ ] Step 6: Copy search.test.ts from shop-pi-fy (unchanged)

Copy `~/.pi/agent/git/github.com/shopify-playground/shop-pi-fy/extensions/memory/search.test.ts` to `~/Code/memory-bank/extensions/memory/search.test.ts` verbatim.

- [ ] Step 7: Install dependencies

Run: `cd ~/Code/memory-bank && pnpm install`
Expected: Clean install, lockfile created

- [ ] Step 8: Run tests to verify search module works

Run: `cd ~/Code/memory-bank && pnpm test`
Expected: All search tests PASS

- [ ] Step 9: Commit

```bash
cd ~/Code/memory-bank
git init
git add -A
git commit -m "feat: package scaffold with search module from shop-pi-fy"
```

---

### Task 2: Main extension — helpers, scaffold, session lifecycle

**Depends on:** Task 1

**Files:**
- Create: `~/Code/memory-bank/extensions/memory/index.ts`

This task creates the extension shell with: helpers, scaffold(), session_start archiving, and the search index. No tools or commands yet — those are Task 3 and Task 4.

- [ ] Step 1: Write the extension shell

```ts
/**
 * Memory Bank — Recall-Only
 *
 * Persistent memory bank that does NOT inject context into every prompt.
 * Context is only loaded on-demand via /recall command.
 *
 * Provides tools for reading/writing/searching memory and a /recall command
 * for manual context injection.
 *
 * Memory bank location: ~/.pi/memory/
 *   core/activeProjects.md  — active work and priorities
 *   core/dailyContext.md    — today's work, decisions, carry-forward
 *   knowledge/              — reference docs (auto-discovered via search)
 *   history/daily/          — archived dailyContext by date
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { MemoryIndex } from "./search.js";

const MEMORY_ROOT = process.env.PI_MEMORY_DIR ?? path.join(os.homedir(), ".pi", "memory");
const CORE_DIR = path.join(MEMORY_ROOT, "core");
const KNOWLEDGE_DIR = path.join(MEMORY_ROOT, "knowledge");
const HISTORY_DIR = path.join(MEMORY_ROOT, "history", "daily");

const memoryIndex = new MemoryIndex(MEMORY_ROOT);

// ── Helpers ──────────────────────────────────────────────────────

function ensureDirs() {
	for (const dir of [CORE_DIR, KNOWLEDGE_DIR, HISTORY_DIR]) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

function readIfExists(filePath: string): string | null {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

function extractDate(content: string): string | null {
	const match = content.match(/^##?\s*(?:Date:?\s*)?(\d{4}-\d{2}-\d{2})/m);
	return match?.[1] ?? null;
}

function extractSection(content: string, heading: string): string | null {
	const regex = new RegExp(`^###?\\s+${heading}\\s*$`, "m");
	const match = content.match(regex);
	if (!match || match.index === undefined) return null;

	const start = match.index + match[0].length;
	const nextHeading = content.slice(start).search(/^###?\s+/m);
	const section = nextHeading === -1
		? content.slice(start)
		: content.slice(start, start + nextHeading);

	return section.trim() || null;
}

function archiveDailyContext(): { archived: boolean; archivePath?: string } {
	const dailyPath = path.join(CORE_DIR, "dailyContext.md");
	const content = readIfExists(dailyPath);
	if (!content) return { archived: false };

	const fileDate = extractDate(content);
	if (!fileDate || fileDate === today()) return { archived: false };

	const ym = fileDate.slice(0, 7);
	const archiveDir = path.join(HISTORY_DIR, ym);
	fs.mkdirSync(archiveDir, { recursive: true });

	const archivePath = path.join(archiveDir, `${fileDate}-dailyContext.md`);
	fs.writeFileSync(archivePath, content, "utf-8");

	const carryForward = extractSection(content, "Context for Tomorrow") ?? "";
	const fresh = [
		`## ${today()}`,
		"",
		"### Current Session",
		"- Starting new session",
		"",
		...(carryForward ? ["### Carried Forward", carryForward, ""] : []),
		"### In Progress",
		"",
		"### Completed",
		"",
		"### Key Decisions",
		"",
		"### Context for Tomorrow",
		"",
	].join("\n");

	fs.writeFileSync(dailyPath, fresh, "utf-8");
	return { archived: true, archivePath };
}

function scaffold() {
	ensureDirs();

	const activeProjectsPath = path.join(CORE_DIR, "activeProjects.md");
	if (!fs.existsSync(activeProjectsPath)) {
		fs.writeFileSync(
			activeProjectsPath,
			[
				"# Active Projects",
				"",
				"<!-- Format: - [Project Name] (P0-P4) - path/or/description - [aliases] -->",
				"",
				"## P0 — Critical",
				"",
				"## P1 — High",
				"",
				"## P2 — Medium",
				"",
				"## P3 — Low",
				"",
			].join("\n"),
			"utf-8",
		);
	}

	const dailyContextPath = path.join(CORE_DIR, "dailyContext.md");
	if (!fs.existsSync(dailyContextPath)) {
		fs.writeFileSync(
			dailyContextPath,
			[
				`## ${today()}`,
				"",
				"### Current Session",
				"- First session with memory bank",
				"",
				"### In Progress",
				"",
				"### Completed",
				"",
				"### Key Decisions",
				"",
				"### Context for Tomorrow",
				"",
			].join("\n"),
			"utf-8",
		);
	}

	const indexPath = path.join(KNOWLEDGE_DIR, "index.csv");
	if (!fs.existsSync(indexPath)) {
		fs.writeFileSync(indexPath, "filename,description,trigger_words\n", "utf-8");
	}
}

function listRecursive(dir: string, root: string, maxDepth = 3, depth = 0): string[] {
	if (depth >= maxDepth) return [];
	const entries: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		const rel = path.relative(root, full);
		if (entry.isDirectory()) {
			entries.push(`${rel}/`);
			entries.push(...listRecursive(full, root, maxDepth, depth + 1));
		} else {
			entries.push(rel);
		}
	}
	return entries;
}

// ── Extension ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	scaffold();
	memoryIndex.build();

	// ── Session Start: archive + rebuild index ──
	pi.on("session_start", async (_event, ctx) => {
		const archive = archiveDailyContext();
		if (archive.archived) {
			ctx.ui.notify(`Archived previous dailyContext → ${archive.archivePath}`, "info");
		}
		const count = memoryIndex.build();
		ctx.ui.notify(`Memory bank: ${count} documents indexed (recall-only mode)`, "info");
	});

	// NOTE: No before_agent_start hook. Context is only injected via /recall.

	// Tools and commands registered in subsequent tasks...
}
```

- [ ] Step 2: Verify it type-checks

Run: `cd ~/Code/memory-bank && pnpm typecheck`
Expected: No errors

- [ ] Step 3: Commit

```bash
cd ~/Code/memory-bank
git add extensions/memory/index.ts
git commit -m "feat: extension shell with helpers, scaffold, and session lifecycle"
```

---

### Task 3: Memory tools (read, update, append, search, list)

**Depends on:** Task 2

**Files:**
- Modify: `~/Code/memory-bank/extensions/memory/index.ts` — add tool registrations inside `export default function`

- [ ] Step 1: Add all 5 tools to the extension

Replace the `// Tools and commands registered in subsequent tasks...` comment in `index.ts` with the following tool registrations:

```ts
	// ── Tool: memory_read ──
	pi.registerTool({
		name: "memory_read",
		label: "Memory Read",
		description:
			"Read a file from the persistent memory bank. Use to check activeProjects, dailyContext, knowledge files, or daily history.",
		promptSnippet: "Read persistent memory bank files (activeProjects, dailyContext, knowledge, history)",
		parameters: Type.Object({
			file: Type.String({
				description:
					"Relative path within ~/.pi/memory/ — e.g. core/activeProjects.md, core/dailyContext.md, knowledge/index.csv, history/daily/2025-03/2025-03-03-dailyContext.md",
			}),
		}),
		async execute(_toolCallId, params) {
			const filePath = path.resolve(MEMORY_ROOT, params.file);
			if (!filePath.startsWith(MEMORY_ROOT)) {
				return {
					content: [{ type: "text", text: "Error: path must be within the memory bank directory." }],
					isError: true,
				};
			}
			const content = readIfExists(filePath);
			if (content === null) {
				return {
					content: [{ type: "text", text: `File not found: ${params.file}` }],
					isError: true,
				};
			}
			return { content: [{ type: "text", text: content }] };
		},
	});

	// ── Tool: memory_update ──
	pi.registerTool({
		name: "memory_update",
		label: "Memory Update",
		description:
			"Update a file in the persistent memory bank. Use to maintain activeProjects.md, dailyContext.md, or knowledge files across sessions.",
		promptSnippet: "Update persistent memory bank files (activeProjects, dailyContext, knowledge)",
		promptGuidelines: [
			"Update dailyContext.md throughout the session: log completed work, decisions, and carry-forward items.",
			"Update activeProjects.md when project status changes (new projects, completed work, priority shifts).",
			"When updating dailyContext.md sections, APPEND to existing entries — never overwrite the whole section.",
			"Keep dailyContext.md under 150 lines. Keep activeProjects.md under 50 lines.",
			"When the user establishes conventions, tone/voice rules, architectural decisions, workflow preferences, " +
				"or any reusable guidance — immediately store it as a knowledge file in knowledge/<name>.md. " +
				"Don't wait to be asked. Knowledge files are for things that should survive beyond today. " +
				"If you'd need to re-derive it in a future session, it belongs in knowledge/.",
			"Knowledge files should be concise: target 10-50 lines, max 100 lines. If a knowledge file grows past " +
				"100 lines, split it into focused files. Each file should cover one topic or convention.",
			"Include source attribution in knowledge files: who said it, when, and where (PR, Slack thread, meeting). " +
				"Add a '## Source' section at the bottom.",
			"If a pattern looks like a multi-step workflow (3+ steps that repeat), it belongs as a Skill, not a knowledge file.",
			"dailyContext entries must be concise: Completed items 15-25 words, Key Decisions 10-20 words, " +
				"activeProjects one line per project. Use progressive refinement: draft full, then shorten.",
			"Each fact belongs in exactly one dailyContext section. Completed = actions taken (what you did). " +
				"Key Decisions = outcomes decided (what was resolved, with rationale). " +
				"Don't repeat the same information across sections. If a meeting produced a decision, " +
				"Completed says 'Held meeting with X' and Key Decisions captures the outcome.",
			"Before modifying code, committing, or taking any irreversible action, consider: is there a knowledge " +
				"file about conventions for this area? If unsure, call memory_search with the relevant topic first. " +
				"This is especially important for: git conventions, component patterns, API design rules, and testing standards.",
		],
		parameters: Type.Object({
			file: Type.String({
				description:
					"Relative path within ~/.pi/memory/ — e.g. core/dailyContext.md, core/activeProjects.md, knowledge/git-rules.md",
			}),
			content: Type.String({ description: "Full file content to write" }),
		}),
		async execute(_toolCallId, params) {
			const filePath = path.resolve(MEMORY_ROOT, params.file);
			if (!filePath.startsWith(MEMORY_ROOT)) {
				return {
					content: [{ type: "text", text: "Error: path must be within the memory bank directory." }],
					isError: true,
				};
			}
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, params.content, "utf-8");
			memoryIndex.updateDocument(params.file);
			return {
				content: [{ type: "text", text: `Updated ${params.file} (${params.content.length} bytes)` }],
			};
		},
	});

	// ── Tool: memory_append ──
	pi.registerTool({
		name: "memory_append",
		label: "Memory Append",
		description:
			"Append text to a section in a memory bank file. Safer than memory_update for adding entries to dailyContext.md without overwriting.",
		promptSnippet: "Append entries to a section in a memory bank file",
		parameters: Type.Object({
			file: Type.String({
				description: "Relative path within ~/.pi/memory/ — e.g. core/dailyContext.md",
			}),
			section: Type.String({
				description: 'Section heading to append to — e.g. "Completed", "In Progress", "Key Decisions"',
			}),
			text: Type.String({
				description: "Text to append (one entry per line, use - prefix for list items)",
			}),
		}),
		async execute(_toolCallId, params) {
			const filePath = path.resolve(MEMORY_ROOT, params.file);
			if (!filePath.startsWith(MEMORY_ROOT)) {
				return {
					content: [{ type: "text", text: "Error: path must be within the memory bank directory." }],
					isError: true,
				};
			}
			const content = readIfExists(filePath);
			if (content === null) {
				return {
					content: [{ type: "text", text: `File not found: ${params.file}` }],
					isError: true,
				};
			}

			const regex = new RegExp(`^(###?\\s+${params.section}\\s*)$`, "m");
			const match = content.match(regex);
			if (!match || match.index === undefined) {
				return {
					content: [{ type: "text", text: `Section "${params.section}" not found in ${params.file}` }],
					isError: true,
				};
			}

			const insertPoint = match.index + match[0].length;
			const after = content.slice(insertPoint);
			const nextHeading = after.search(/^###?\s+/m);

			let updated: string;
			if (nextHeading === -1) {
				updated = content.trimEnd() + "\n" + params.text + "\n";
			} else {
				const before = content.slice(0, insertPoint + nextHeading);
				const rest = content.slice(insertPoint + nextHeading);
				updated = before.trimEnd() + "\n" + params.text + "\n\n" + rest;
			}

			fs.writeFileSync(filePath, updated, "utf-8");
			memoryIndex.updateDocument(params.file);
			return {
				content: [{ type: "text", text: `Appended to "${params.section}" in ${params.file}` }],
			};
		},
	});

	// ── Tool: memory_search ──
	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description:
			"Search across all memory bank files — knowledge, daily history, and core files. " +
			"Uses BM25 fuzzy matching. " +
			"Use to find past decisions, recall context from previous sessions, or discover relevant knowledge files.",
		promptSnippet: "Search across all memory bank files (knowledge, history, core) with fuzzy full-text search",
		parameters: Type.Object({
			query: Type.String({
				description: "Search query — natural language or keywords. Fuzzy matching handles typos and partial words.",
			}),
			limit: Type.Optional(
				Type.Number({ description: "Max results to return (default 5)" }),
			),
		}),
		async execute(_toolCallId, params) {
			const limit = params.limit ?? 5;
			const results = memoryIndex.search(params.query, limit);

			if (results.length === 0) {
				return {
					content: [{ type: "text", text: `No results found for "${params.query}"` }],
				};
			}

			const formatted = results
				.map((r, i) => [
					`${i + 1}. **${r.title}** (${r.category})`,
					`   Path: ${r.path} | Score: ${Math.round(r.score)}`,
					`   ${r.snippet}`,
				].join("\n"))
				.join("\n\n");

			return {
				content: [{ type: "text", text: `Found ${results.length} results for "${params.query}":\n\n${formatted}` }],
			};
		},
	});

	// ── Tool: memory_list ──
	pi.registerTool({
		name: "memory_list",
		label: "Memory List",
		description: "List files in the memory bank. Use to discover available knowledge files and history archives.",
		promptSnippet: "List files in the persistent memory bank",
		parameters: Type.Object({
			directory: Type.Optional(
				Type.String({
					description:
						'Relative directory within ~/.pi/memory/ — e.g. "knowledge", "history/daily", "core". Defaults to root.',
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const dir = path.resolve(MEMORY_ROOT, params.directory ?? ".");
			if (!dir.startsWith(MEMORY_ROOT)) {
				return {
					content: [{ type: "text", text: "Error: path must be within the memory bank directory." }],
					isError: true,
				};
			}
			try {
				const entries = listRecursive(dir, MEMORY_ROOT);
				if (entries.length === 0) {
					return { content: [{ type: "text", text: "(empty)" }] };
				}
				return { content: [{ type: "text", text: entries.join("\n") }] };
			} catch {
				return {
					content: [{ type: "text", text: `Directory not found: ${params.directory ?? "."}` }],
					isError: true,
				};
			}
		},
	});
```

- [ ] Step 2: Verify it type-checks

Run: `cd ~/Code/memory-bank && pnpm typecheck`
Expected: No errors

- [ ] Step 3: Commit

```bash
cd ~/Code/memory-bank
git add extensions/memory/index.ts
git commit -m "feat: add memory tools (read, update, append, search, list)"
```

---

### Task 4: /recall and /memory commands

**Depends on:** Task 3

**Files:**
- Modify: `~/Code/memory-bank/extensions/memory/index.ts` — add commands after the tool registrations

- [ ] Step 1: Add /recall and /memory commands

Insert after the `memory_list` tool registration:

```ts
	// ── Command: /recall ──
	pi.registerCommand("recall", {
		description:
			"Inject memory bank context into the current conversation. " +
			"Usage: /recall (loads activeProjects + dailyContext + auto-search) or /recall <query> (searches memory for specific topic).",
		handler: async (args, ctx) => {
			const parts: string[] = ["# Memory Bank Context\n"];

			const activeProjects = readIfExists(path.join(CORE_DIR, "activeProjects.md"));
			const dailyContext = readIfExists(path.join(CORE_DIR, "dailyContext.md"));

			if (activeProjects) {
				parts.push("## Active Projects\n", activeProjects, "");
			}
			if (dailyContext) {
				parts.push("## Daily Context\n", dailyContext, "");
			}

			// If args provided, use as search query; otherwise search with a generic recall
			const query = args.trim();
			if (query) {
				const hits = memoryIndex.searchForContext(query, 5);
				if (hits.length > 0) {
					parts.push("## Search Results\n");
					for (const hit of hits) {
						parts.push(`--- ${hit.path} (score: ${Math.round(hit.score)}) ---\n${hit.content}\n`);
					}
				} else {
					parts.push(`(No memory results for "${query}")\n`);
				}
			}

			const content = parts.join("\n");
			const bytes = Buffer.byteLength(content, "utf-8");

			// Inject as a persistent message in the session
			pi.appendEntry({
				type: "message",
				message: {
					role: "user",
					content,
					customType: "memory-recall",
				},
			});

			ctx.ui.notify(
				`Recalled ${query ? `"${query}" + ` : ""}core context (${(bytes / 1024).toFixed(1)}KB)`,
				"info",
			);
		},
	});

	// ── Command: /memory ──
	pi.registerCommand("memory", {
		description: "Show memory bank status — file sizes, knowledge count, archive count, search index stats.",
		handler: async (_args, ctx) => {
			const activeProjects = readIfExists(path.join(CORE_DIR, "activeProjects.md"));
			const dailyContext = readIfExists(path.join(CORE_DIR, "dailyContext.md"));

			const lines: string[] = [`Memory bank: ${MEMORY_ROOT}`, ""];

			lines.push(`activeProjects.md: ${activeProjects ? `${activeProjects.split("\n").length} lines` : "missing"}`);
			lines.push(`dailyContext.md:   ${dailyContext ? `${dailyContext.split("\n").length} lines` : "missing"}`);

			let knowledgeCount = 0;
			try {
				knowledgeCount = fs.readdirSync(KNOWLEDGE_DIR).filter((f) => f.endsWith(".md")).length;
			} catch {}
			lines.push(`knowledge files:   ${knowledgeCount}`);

			let archiveCount = 0;
			try {
				const months = fs.readdirSync(HISTORY_DIR);
				for (const month of months) {
					const monthDir = path.join(HISTORY_DIR, month);
					if (fs.statSync(monthDir).isDirectory()) {
						archiveCount += fs.readdirSync(monthDir).length;
					}
				}
			} catch {}
			lines.push(`daily archives:    ${archiveCount} files`);
			lines.push(`search index:      ${memoryIndex.documentCount} documents`);
			lines.push(`injection mode:    recall-only (no auto-injection)`);

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
```

- [ ] Step 2: Verify it type-checks

Run: `cd ~/Code/memory-bank && pnpm typecheck`
Expected: No errors

- [ ] Step 3: Commit

```bash
cd ~/Code/memory-bank
git add extensions/memory/index.ts
git commit -m "feat: add /recall and /memory commands"
```

---

### Task 5: README + integration test

**Depends on:** Task 4

**Files:**
- Create: `~/Code/memory-bank/README.md`

- [ ] Step 1: Write README

```markdown
# memory-bank — Recall-Only Memory for Pi

Persistent memory bank that does **not** inject context into every prompt. Fork of [shop-pi-fy](https://github.com/shopify-playground/shop-pi-fy)'s memory extension with the `before_agent_start` auto-injection removed.

## Why

The original memory extension injects `activeProjects.md` + `dailyContext.md` + up to 3 search results into every single prompt. This adds 5-25KB of context per message — most of which is irrelevant to the current question.

This package keeps all the write/search tools but only injects context when you explicitly ask for it.

## Install

```bash
# Remove the shop-pi-fy memory extension first
# (via /pkg rm memory, or: rm ~/.pi/agent/extensions/memory)

pi install ~/Code/memory-bank
```

## Commands

| Command | Description |
|---------|-------------|
| `/recall` | Inject activeProjects + dailyContext into conversation |
| `/recall <query>` | Inject core context + search results for query |
| `/memory` | Show memory bank status |

## Tools

All 5 original memory tools work exactly as before:

- `memory_read` — read any file from `~/.pi/memory/`
- `memory_update` — write a file (with prompt guidelines for the agent)
- `memory_append` — safely append to a section in a file
- `memory_search` — BM25 fuzzy search across all memory files
- `memory_list` — list files in the memory bank

## What changed from shop-pi-fy memory

| Area | shop-pi-fy | memory-bank |
|------|-----------|-------------|
| Auto-injection | Every prompt | **Never** |
| `/recall` | N/A | **New** — manual context injection |
| qmd support | Optional semantic search | **Removed** |
| Package type | Part of monorepo | Standalone |

## Memory bank location

Same as before: `~/.pi/memory/` (override with `PI_MEMORY_DIR` env var).
```

- [ ] Step 2: Commit

```bash
cd ~/Code/memory-bank
git add README.md
git commit -m "docs: add README"
```

---

### Task 6: Smoke test — install and verify

**Depends on:** Task 5

- [ ] Step 1: Remove shop-pi-fy memory symlink

```bash
rm ~/.pi/agent/extensions/memory
```

- [ ] Step 2: Install the new package

```bash
pi install ~/Code/memory-bank
```

- [ ] Step 3: Restart pi and verify

Start a new pi session. Verify:
1. No `# Memory Bank Context` appears in the injected context (no auto-injection)
2. `/memory` command works and shows stats
3. `/recall` injects context on demand
4. `memory_read`, `memory_update`, `memory_append`, `memory_search`, `memory_list` tools all work
5. The agent still writes to dailyContext.md throughout the session (prompted by the `promptGuidelines`)
