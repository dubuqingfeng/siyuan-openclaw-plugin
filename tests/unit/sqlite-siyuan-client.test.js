import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Database from "better-sqlite3";
import { SqliteSiYuanClient } from "../../scripts/lib/sqlite-siyuan-client.js";

describe("SqliteSiYuanClient", () => {
  /** @type {string[]} */
  const toCleanup = [];

  afterEach(() => {
    for (const p of toCleanup.splice(0)) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  function makeDb() {
    const dir = mkdtempSync(join(tmpdir(), "siyuan-openclaw-"));
    toCleanup.push(dir);
    const dbPath = join(dir, "siyuan.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE blocks (
        id TEXT PRIMARY KEY,
        root_id TEXT,
        hpath TEXT,
        type TEXT,
        content TEXT,
        updated TEXT
      );
    `);
    return { db, dbPath };
  }

  function makeOpenclawIndexDb() {
    const dir = mkdtempSync(join(tmpdir(), "siyuan-openclaw-idx-"));
    toCleanup.push(dir);
    const dbPath = join(dir, "siyuan-index.sqlite");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE doc_registry (
        doc_id TEXT PRIMARY KEY,
        title TEXT,
        hpath TEXT,
        updated_at TEXT,
        indexed_at TEXT DEFAULT CURRENT_TIMESTAMP,
        deleted INTEGER DEFAULT 0,
        deleted_at TEXT,
        tags TEXT
      );
      CREATE VIRTUAL TABLE block_fts USING fts5(
        block_id UNINDEXED,
        doc_id UNINDEXED,
        content,
        tokenize = 'porter unicode61'
      );
    `);
    return { db, dbPath };
  }

  it("healthCheck returns available when blocks table exists", async () => {
    const { db, dbPath } = makeDb();
    db.prepare(
      "INSERT INTO blocks (id, root_id, hpath, type, content, updated) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("d1", "d1", "/A", "d", "Doc A", "2026-02-10");
    db.close();

    const client = new SqliteSiYuanClient({ dbPath });
    const health = await client.healthCheck();
    expect(health.available).toBe(true);
    client.close();
  });

  it("query executes SQL and returns rows", async () => {
    const { db, dbPath } = makeDb();
    db.prepare(
      "INSERT INTO blocks (id, root_id, hpath, type, content, updated) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("b1", "d1", "/A", "p", "Hello world", "2026-02-11");
    db.close();

    const client = new SqliteSiYuanClient({ dbPath });
    const rows = await client.query("SELECT id, content FROM blocks WHERE id = 'b1'");
    expect(rows).toEqual([{ id: "b1", content: "Hello world" }]);
    client.close();
  });

  it("searchFullText uses LIKE matching and paginates", async () => {
    const { db, dbPath } = makeDb();
    const ins = db.prepare(
      "INSERT INTO blocks (id, root_id, hpath, type, content, updated) VALUES (?, ?, ?, ?, ?, ?)",
    );
    // Include a doc block and two paragraph blocks; doc block should be excluded.
    ins.run("d1", "d1", "/Doc", "d", "Doc Title", "2026-02-12");
    ins.run("b1", "d1", "/Doc", "p", "Rust ownership rules", "2026-02-13");
    ins.run("b2", "d1", "/Doc", "p", "More about ownership", "2026-02-14");
    ins.run("b3", "d2", "/Doc2", "p", "Unrelated note", "2026-02-15");
    db.close();

    const client = new SqliteSiYuanClient({ dbPath });
    const page1 = await client.searchFullText("ownership", { page: 1, size: 1 });
    expect(page1).toHaveLength(1);
    expect(page1[0].id).toBe("b2"); // newest first by updated

    const page2 = await client.searchFullText("ownership", { page: 2, size: 1 });
    expect(page2).toHaveLength(1);
    expect(page2[0].id).toBe("b1");

    client.close();
  });

  it("supports OpenClaw index schema (block_fts + doc_registry)", async () => {
    const { db, dbPath } = makeOpenclawIndexDb();
    db.prepare(
      "INSERT INTO doc_registry (doc_id, title, hpath, updated_at, deleted) VALUES (?, ?, ?, ?, 0)",
    ).run("d1", "Doc A", "/A", "2026-02-15");
    db.prepare("INSERT INTO block_fts (block_id, doc_id, content) VALUES (?, ?, ?)").run(
      "b1",
      "d1",
      "Rust ownership rules",
    );
    db.close();

    const client = new SqliteSiYuanClient({ dbPath });
    const health = await client.healthCheck();
    expect(health.available).toBe(true);

    const rows = await client.query("SELECT id, content FROM blocks WHERE id = 'b1'");
    expect(rows).toEqual([{ id: "b1", content: "Rust ownership rules" }]);

    const hits = await client.searchFullText("ownership", { page: 1, size: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].id).toBe("b1");

    client.close();
  });
});
