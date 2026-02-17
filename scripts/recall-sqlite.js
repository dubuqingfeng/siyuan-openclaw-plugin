#!/usr/bin/env node
import { existsSync } from "fs";
import Database from "better-sqlite3";
import { IndexManager } from "../src/infra/index-manager.js";
import { SqliteSiYuanClient } from "./lib/sqlite-siyuan-client.js";
import { MemoryRecall } from "../src/services/memory-recall.js";

function printHelp() {
  // Keep this short; this is a dev utility.
  console.log(`Usage:
  pnpm recall:sqlite -- --siyuan-db /path/to/siyuan.db --prompt "你的问题"

Options:
  --siyuan-db <path>     SQLite DB path:
                         - SiYuan storage DB (table: blocks), or
                         - OpenClaw local index DB (tables: block_fts + doc_registry)
  --prompt <text>        Prompt to test recall with
  --force                Force recall (prefixes a recall-force phrase)
  --paths <a,b,c>        Search paths: fts,fulltext,sql (default: fulltext,sql)
  --index-db <path>      Existing OpenClaw local index db path (enables fts path)
  --build-index           Build a temporary local index from siyuan-db (enables fts path)
  --max-docs <n>         When building index: max docs to index (default: 200)
  --max-blocks <n>       When building index: max blocks per doc (default: 60)
  --json                 Print raw JSON result
  -h, --help             Show help

Examples:
  pnpm recall:sqlite -- --siyuan-db ~/SiYuan/data/storage/siyuan.db --prompt "Rust ownership 是什么？" --force
  pnpm recall:sqlite -- --siyuan-db ./siyuan.db --prompt "OAuth token 刷新" --build-index --paths fts,sql
`);
}

function parseArgs(argv) {
  const args = {};
  const rest = [...argv];
  while (rest.length) {
    const a = rest.shift();
    if (a === "--") continue;
    if (a === "-h" || a === "--help") {
      args.help = true;
      continue;
    }
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = rest[0];
      if (next == null || next.startsWith("-")) {
        args[k] = true; // boolean flag
      } else {
        args[k] = rest.shift();
      }
      continue;
    }
    // ignore unknown positional args
  }
  return args;
}

function parsePaths(s) {
  if (!s || typeof s !== "string") return null;
  const allowed = new Set(["fts", "fulltext", "sql"]);
  const paths = s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => allowed.has(x));
  return paths.length ? paths : null;
}

function toInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function ensureBlocksTable(db) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='blocks'")
    .get();
  if (!row) throw new Error("siyuan-db missing table: blocks");
}

function getBlocksColumns(db) {
  const cols = db
    .prepare("PRAGMA table_info('blocks')")
    .all()
    .map((r) => r?.name)
    .filter(Boolean);
  return new Set(cols);
}

function buildIndexFromSiYuanDb({ siyuanDbPath, indexDbPath, maxDocs, maxBlocksPerDoc }) {
  const src = new Database(siyuanDbPath, { readonly: true, fileMustExist: true });
  ensureBlocksTable(src);
  const cols = getBlocksColumns(src);

  if (!cols.has("type")) {
    throw new Error("siyuan-db blocks table missing column: type");
  }
  if (!cols.has("id")) {
    throw new Error("siyuan-db blocks table missing column: id");
  }
  if (!cols.has("content")) {
    // Most SiYuan DBs have it; keep the error explicit so users know what to provide.
    throw new Error("siyuan-db blocks table missing column: content");
  }

  const hasHpath = cols.has("hpath");
  const hasUpdated = cols.has("updated");
  const hasRootId = cols.has("root_id");
  if (!hasRootId) {
    throw new Error("siyuan-db blocks table missing column: root_id (required for --build-index)");
  }

  const docRows = src
    .prepare(
      `
      SELECT
        id,
        content AS title,
        ${hasHpath ? "hpath" : "'' AS hpath"},
        ${hasUpdated ? "updated" : "'' AS updated"}
      FROM blocks
      WHERE type = 'd'
      ORDER BY ${hasUpdated ? "updated DESC" : "id DESC"}
      LIMIT ?
    `,
    )
    .all(maxDocs);

  const indexManager = new IndexManager({ dbPath: indexDbPath });
  const fetchBlocks = src.prepare(
    `
    SELECT
      id,
      content,
      ${hasUpdated ? "updated" : "'' AS updated"},
      ${hasHpath ? "hpath" : "'' AS hpath"},
      ${hasRootId ? "root_id" : "'' AS root_id"}
    FROM blocks
    WHERE root_id = ?
      AND type != 'd'
      AND content IS NOT NULL
      AND TRIM(content) != ''
    ORDER BY ${hasUpdated ? "updated DESC" : "id DESC"}
    LIMIT ?
  `,
  );

  for (const d of docRows) {
    const docId = d.id;
    if (!docId) continue;
    const blocks = fetchBlocks.all(docId, maxBlocksPerDoc);
    const docContent = blocks
      .map((b) => (typeof b?.content === "string" ? b.content.trim() : ""))
      .filter(Boolean)
      .join("\n");
    indexManager.indexDocument({
      id: docId,
      title: d.title || "",
      hpath: d.hpath || "",
      // Prefer document-level indexing (one "doc block" that represents the whole doc)
      // then keep per-block indexing for better snippet extraction.
      content: docContent,
      updated: d.updated || "",
      blocks: blocks.map((b) => ({
        id: b.id,
        content: b.content,
        updated: b.updated,
      })),
    });
  }

  src.close();
  return indexManager;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const siyuanDb = args["siyuan-db"] || args.siyuanDb;
  const promptRaw = args.prompt;
  if (!siyuanDb || typeof siyuanDb !== "string") {
    console.error("Missing required: --siyuan-db <path>");
    printHelp();
    process.exit(2);
  }
  if (!existsSync(siyuanDb)) {
    console.error(`File not found: ${siyuanDb}`);
    process.exit(2);
  }
  if (!promptRaw || typeof promptRaw !== "string") {
    console.error("Missing required: --prompt <text>");
    printHelp();
    process.exit(2);
  }

  const force = Boolean(args.force);
  const prompt = force ? `查一下我的笔记：${promptRaw}` : promptRaw;
  const paths = parsePaths(args.paths) || ["fulltext", "sql"];

  const config = {
    recall: {
      enabled: true,
      minPromptLength: 1,
      searchPaths: paths,
      // Keep defaults for the rest; this CLI is for quick iteration.
    },
  };

  const client = new SqliteSiYuanClient({ dbPath: siyuanDb });

  let indexManager = null;
  const indexDb = args["index-db"] || args.indexDb;
  const buildIndex = Boolean(args["build-index"] || args.buildIndex);

  try {
    if (indexDb && typeof indexDb === "string") {
      indexManager = new IndexManager({ dbPath: indexDb });
    } else if (buildIndex) {
      const maxDocs = Math.max(1, toInt(args["max-docs"] || args.maxDocs, 200));
      const maxBlocks = Math.max(1, toInt(args["max-blocks"] || args.maxBlocks, 60));
      indexManager = buildIndexFromSiYuanDb({
        siyuanDbPath: siyuanDb,
        indexDbPath: ":memory:",
        maxDocs,
        maxBlocksPerDoc: maxBlocks,
      });
    }

    const recall = new MemoryRecall(client, config, indexManager);
    const result = await recall.recall(prompt);

    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.skipped) {
      console.log(`SKIPPED (${result.reason})`);
      return;
    }

    if (result.error) {
      console.log(`ERROR: ${result.error}`);
      return;
    }

    console.log("Intent:", result.intent);
    console.log("Docs:", result.recalledDocs?.length || 0);
    console.log(result.prependContext || "");
  } finally {
    try {
      indexManager?.close?.();
    } catch {
      // ignore
    }
    try {
      client?.close?.();
    } catch {
      // ignore
    }
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
