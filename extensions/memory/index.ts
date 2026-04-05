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
					details: {},
				};
			}
			const content = readIfExists(filePath);
			if (content === null) {
				return {
					content: [{ type: "text", text: `File not found: ${params.file}` }],
					isError: true,
					details: {},
				};
			}
			return { content: [{ type: "text", text: content }], details: {} };
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
					details: {},
				};
			}
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, params.content, "utf-8");
			memoryIndex.updateDocument(params.file);
			return {
				content: [{ type: "text", text: `Updated ${params.file} (${params.content.length} bytes)` }],
				details: {},
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
					details: {},
				};
			}
			const content = readIfExists(filePath);
			if (content === null) {
				return {
					content: [{ type: "text", text: `File not found: ${params.file}` }],
					isError: true,
					details: {},
				};
			}

			const regex = new RegExp(`^(###?\\s+${params.section}\\s*)$`, "m");
			const match = content.match(regex);
			if (!match || match.index === undefined) {
				return {
					content: [{ type: "text", text: `Section "${params.section}" not found in ${params.file}` }],
					isError: true,
					details: {},
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
				details: {},
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
					details: {},
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
				details: {},
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
					details: {},
				};
			}
			try {
				const entries = listRecursive(dir, MEMORY_ROOT);
				if (entries.length === 0) {
					return { content: [{ type: "text", text: "(empty)" }], details: {} };
				}
				return { content: [{ type: "text", text: entries.join("\n") }], details: {} };
			} catch {
				return {
					content: [{ type: "text", text: `Directory not found: ${params.directory ?? "."}` }],
					isError: true,
					details: {},
				};
			}
		},
	});

	// ── Command: /recall ──
	pi.registerCommand("recall", {
		description:
			"Inject memory bank context into the current conversation. " +
			"Usage: /recall (loads activeProjects + dailyContext) or /recall <query> (also searches memory for specific topic).",
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

			pi.sendMessage(
				{ customType: "memory-recall", content, display: false },
				{ triggerTurn: false },
			);

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
}
