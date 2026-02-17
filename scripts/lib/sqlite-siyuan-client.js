import Database from "better-sqlite3";
import { existsSync } from "fs";

/**
 * Minimal SiYuan-like client backed by a local SQLite database.
 *
 * This is intended for offline / CLI testing of the recall pipeline without
 * needing a running SiYuan instance or HTTP API.
 *
 * It implements the subset of methods used by `MemoryRecall`:
 * - query(stmt): execute SQL and return rows
 * - searchFullText(query, options): simple LIKE-based search against blocks
 * - healthCheck(): basic validation that the db is readable and has `blocks`
 */
export class SqliteSiYuanClient {
  /**
   * @param {object} config
   * @param {string} config.dbPath - Path to SiYuan SQLite DB (must exist)
   */
  constructor(config) {
    const dbPath = config?.dbPath;
    if (!dbPath || typeof dbPath !== "string") {
      throw new Error("dbPath is required");
    }
    if (!existsSync(dbPath)) {
      throw new Error(`SQLite db not found: ${dbPath}`);
    }

    this.dbPath = dbPath;
    this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
    this.schema = this.detectSchema();
    this.blockColumns = this.detectBlockColumns();
  }

  detectSchema() {
    const hasTable = (name) => {
      const row = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
        .get(name);
      return Boolean(row?.name);
    };

    // 1) SiYuan's storage DB (or a compatible export) typically has `blocks`.
    if (hasTable("blocks")) return { type: "siyuan_blocks" };

    // 2) OpenClaw local index DB (created by IndexManager) has `block_fts` + `doc_registry`.
    if (hasTable("block_fts") && hasTable("doc_registry")) return { type: "openclaw_index" };

    return { type: "unknown" };
  }

  detectBlockColumns() {
    if (this.schema.type === "openclaw_index") {
      // OpenClaw index schema is fixed; return a compatible "virtual blocks" shape.
      return {
        cols: new Set(["id", "root_id", "hpath", "content", "updated"]),
        contentColumn: "content",
      };
    }

    const cols =
      this.schema.type === "siyuan_blocks"
        ? this.db
            .prepare("PRAGMA table_info('blocks')")
            .all()
            .map((r) => r?.name)
            .filter(Boolean)
        : [];

    // Prefer the most-readable text field for searching.
    const contentColumn =
      (cols.includes("content") && "content") ||
      (cols.includes("fcontent") && "fcontent") ||
      (cols.includes("markdown") && "markdown") ||
      (cols.includes("name") && "name") ||
      null;

    return {
      cols: new Set(cols),
      contentColumn,
    };
  }

  async healthCheck() {
    try {
      if (this.schema.type === "siyuan_blocks") {
        this.db.prepare("SELECT 1 FROM blocks LIMIT 1").get();
        return { available: true, version: "sqlite" };
      }

      if (this.schema.type === "openclaw_index") {
        this.db.prepare("SELECT 1 FROM block_fts LIMIT 1").get();
        this.db.prepare("SELECT 1 FROM doc_registry LIMIT 1").get();
        return { available: true, version: "sqlite_openclaw_index" };
      }

      return { available: false, error: "unsupported_schema" };
    } catch (error) {
      return { available: false, error: error?.message || String(error) };
    }
  }

  rewriteBlocksQueryForOpenclawIndex(stmt) {
    // Best-effort rewrite for the SQL emitted by MemoryRecall.searchSQL (and simple selects).
    // This allows using an OpenClaw index DB as a drop-in "blocks" provider for offline recall.
    const m = String(stmt || "").match(/^\s*select\s+([\s\S]+?)\s+from\s+blocks\b([\s\S]*)$/i);
    if (!m) return null;

    let selectList = m[1] || "*";
    let tail = m[2] || "";

    // Normalize accidental table prefixes (blocks.id, etc.).
    selectList = selectList.replace(/\bblocks\./gi, "");
    tail = tail.replace(/\bblocks\./gi, "");

    const coalesce = (expr, alias) => `COALESCE(${expr}, '') AS ${alias}`;
    const replaceOutsideSingleQuotes = (sql, transform) =>
      String(sql)
        .split(/('(?:''|[^'])*')/g)
        .map((part) => (part.startsWith("'") ? part : transform(part)))
        .join("");

    if (selectList.trim() === "*") {
      selectList = [
        "f.block_id AS id",
        "f.doc_id AS root_id",
        coalesce("d.hpath", "hpath"),
        "f.content AS content",
        coalesce("d.updated_at", "updated"),
      ].join(", ");
    } else {
      // Map common columns from the "virtual blocks" shape (keep it conservative).
      const items = selectList
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      selectList = items
        .map((it) => {
          const norm = it.replace(/\bblocks\./gi, "").trim();
          if (/^id$/i.test(norm)) return "f.block_id AS id";
          if (/^root_id$/i.test(norm)) return "f.doc_id AS root_id";
          if (/^hpath$/i.test(norm)) return coalesce("d.hpath", "hpath");
          if (/^content$/i.test(norm)) return "f.content AS content";
          if (/^updated$/i.test(norm)) return coalesce("d.updated_at", "updated");
          return it;
        })
        .join(", ");
    }

    // Rewrite WHERE/ORDER BY identifiers.
    tail = replaceOutsideSingleQuotes(tail, (s) =>
      s
        .replace(/\broot_id\b/g, "f.doc_id")
        .replace(/\bhpath\b/g, "d.hpath")
        .replace(/\bupdated\b/g, "d.updated_at")
        .replace(/\bcontent\b/g, "f.content")
        .replace(/\bid\b/g, "f.block_id"),
    );

    return `
      SELECT ${selectList}
      FROM block_fts f
      LEFT JOIN doc_registry d ON d.doc_id = f.doc_id
      ${tail}
    `;
  }

  /**
   * Execute a SQL statement and return rows.
   * @param {string} stmt
   * @returns {Promise<Array<object>>}
   */
  async query(stmt) {
    if (typeof stmt !== "string" || !stmt.trim()) return [];
    // `better-sqlite3` throws on multiple statements; that's fine for our use.
    if (this.schema.type === "openclaw_index" && /\bfrom\s+blocks\b/i.test(stmt)) {
      const rewritten = this.rewriteBlocksQueryForOpenclawIndex(stmt);
      if (!rewritten) {
        throw new Error("unsupported_blocks_query_for_openclaw_index");
      }
      return this.db.prepare(rewritten).all();
    }

    return this.db.prepare(stmt).all();
  }

  /**
   * Simple full-text-ish search.
   * SiYuan's HTTP API supports many features; for offline testing we implement
   * a pragmatic LIKE query against a best-effort text column.
   *
   * @param {string} query
   * @param {object} options
   * @param {number} options.page - 1-based page number
   * @param {number} options.size - page size
   * @returns {Promise<Array<object>>}
   */
  async searchFullText(query, options = {}) {
    const q = typeof query === "string" ? query.trim() : "";
    if (!q) return [];

    const sizeRaw = options?.size ?? 20;
    const pageRaw = options?.page ?? 1;
    const size = Number.isFinite(Number(sizeRaw)) ? Math.max(1, Number(sizeRaw)) : 20;
    const page = Number.isFinite(Number(pageRaw)) ? Math.max(1, Number(pageRaw)) : 1;
    const offset = (page - 1) * size;

    if (this.schema.type === "openclaw_index") {
      // Use the index's FTS5 directly.
      const stmt = `
        SELECT
          f.block_id AS id,
          f.doc_id AS root_id,
          COALESCE(d.hpath, '') AS hpath,
          f.content AS content,
          COALESCE(d.updated_at, '') AS updated,
          rank
        FROM block_fts f
        LEFT JOIN doc_registry d ON d.doc_id = f.doc_id
        WHERE block_fts MATCH ?
          AND COALESCE(d.deleted, 0) = 0
        ORDER BY rank
        LIMIT ?
        OFFSET ?
      `;
      return this.db.prepare(stmt).all(q, size, offset);
    }

    const c = this.blockColumns.contentColumn;
    if (!c) {
      // No usable text column; behave like "no results" rather than crashing.
      return [];
    }

    const hasType = this.blockColumns.cols.has("type");
    const hasUpdated = this.blockColumns.cols.has("updated");
    const hasHpath = this.blockColumns.cols.has("hpath");
    const hasRoot = this.blockColumns.cols.has("root_id");

    const selectFields = [
      "id",
      hasRoot ? "root_id" : "id AS root_id",
      hasHpath ? "hpath" : "'' AS hpath",
      `${c} AS content`,
      hasUpdated ? "updated" : "'' AS updated",
    ].join(", ");

    // Most SiYuan DBs have type='d' for docs; exclude doc blocks to reduce noise.
    const where = hasType
      ? `(${c} LIKE ? ESCAPE '\\') AND type != 'd'`
      : `(${c} LIKE ? ESCAPE '\\')`;

    const stmt = `
      SELECT ${selectFields}
      FROM blocks
      WHERE ${where}
      ORDER BY ${hasUpdated ? "updated DESC" : "id DESC"}
      LIMIT ?
      OFFSET ?
    `;

    const like =
      "%" +
      q
        .replace(/\\/g, "\\\\")
        .replace(/%/g, "\\%")
        .replace(/_/g, "\\_") +
      "%";
    return this.db.prepare(stmt).all(like, size, offset);
  }

  close() {
    if (this.db) this.db.close();
  }
}
