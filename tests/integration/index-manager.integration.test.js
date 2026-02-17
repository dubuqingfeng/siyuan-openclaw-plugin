import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "node:os";

import { IndexManager } from "../../src/infra/index-manager.js";

// A real SQLite + FTS5 test (no mocks) to validate the integration between:
// IndexManager <-> better-sqlite3 <-> schema/queries.
describe("IndexManager (integration)", () => {
  /** @type {string} */
  let tempDir;
  /** @type {IndexManager} */
  let mgr;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "siyuan-openclaw-it-"));
    mgr = new IndexManager({ dbPath: join(tempDir, "index.db") });
  });

  afterEach(() => {
    try {
      mgr?.close();
    } finally {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("indexes docs + blocks and can full-text search them", () => {
    mgr.indexDocument({
      id: "doc1",
      title: "Rust Notes",
      hpath: "/Work/Rust",
      updated: "2026-02-16T00:00:00.000Z",
      content: "Rust ownership and borrowing basics.",
      blocks: [{ id: "b1", content: "Lifetimes are part of the type system." }],
    });

    const results = mgr.search("ownership");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].doc_id).toBe("doc1");
    expect(results[0].title).toBe("Rust Notes");
  });

  it("honors excluded notebook names (e.g. privacy notebook)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const excluded = new IndexManager({
      dbPath: join(tempDir, "excluded.db"),
      privacyNotebook: "Private",
    });

    excluded.indexDocument({
      id: "doc-private",
      title: "Secrets",
      hpath: "/Private/TopSecret",
      updated: "2026-02-16T00:00:00.000Z",
      content: "do not index this",
    });

    expect(excluded.search("index").length).toBe(0);
    expect(excluded.getStatistics().totalDocs).toBe(0);

    excluded.close();
    log.mockRestore();
  });

  it("markDeleted hides docs from search, and cleanupOldDeleted purges data", () => {
    mgr.indexDocument({
      id: "doc2",
      title: "Temp",
      hpath: "/Work/Temp",
      updated: "2026-02-16T00:00:00.000Z",
      content: "This will be deleted.",
    });

    expect(mgr.search("deleted").length).toBeGreaterThan(0);

    mgr.markDeleted("doc2");
    expect(mgr.search("deleted").length).toBe(0);

    // Make it old enough for cleanup (SQLite datetime comparisons).
    mgr.db
      .prepare("UPDATE doc_registry SET deleted_at = ? WHERE doc_id = ?")
      .run("2000-01-01T00:00:00.000Z", "doc2");

    mgr.cleanupOldDeleted(1);

    const registryCount = mgr.db
      .prepare("SELECT COUNT(*) AS c FROM doc_registry WHERE doc_id = ?")
      .get("doc2").c;
    const ftsCount = mgr.db
      .prepare("SELECT COUNT(*) AS c FROM block_fts WHERE doc_id = ?")
      .get("doc2").c;

    expect(registryCount).toBe(0);
    expect(ftsCount).toBe(0);
  });
});
