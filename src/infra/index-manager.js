import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

/**
 * Local index manager using SQLite with FTS5
 */
export class IndexManager {
  /**
   * @param {object} config - Index configuration
   * @param {string} config.dbPath - Path to SQLite database
   * @param {string} [config.privacyNotebook] - Notebook name to exclude from indexing
   * @param {string} [config.archiveNotebook] - Notebook name to exclude from indexing
   * @param {string[]} [config.skipNotebookNames] - Additional notebook names to exclude from indexing
   */
  constructor(config) {
    this.dbPath = config.dbPath;
    this.excludedNotebookNames = new Set(
      this.normalizeNotebookNameList([
        config.privacyNotebook,
        config.archiveNotebook,
        ...(Array.isArray(config.skipNotebookNames)
          ? config.skipNotebookNames
          : []),
      ]),
    );

    // Ensure directory exists
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Initialize database
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');

    this.initializeTables();
  }

  normalizeNotebookNameList(names) {
    return (Array.isArray(names) ? names : [])
      .map((n) => String(n || "").trim())
      .filter(Boolean)
      .map((n) => n.replace(/^\/+|\/+$/g, "")) // tolerate "/Notebook"
      .filter(Boolean);
  }

  getNotebookNameFromDoc(doc) {
    if (!doc || typeof doc !== 'object') return null;

    const direct =
      doc.notebook ||
      doc.notebookName ||
      doc.notebook_name ||
      doc.boxName ||
      doc.box_name;
    if (typeof direct === 'string' && direct.trim()) {
      return direct.trim().replace(/^\/+|\/+$/g, '');
    }

    const hpath = typeof doc.hpath === 'string' ? doc.hpath : '';
    const parts = hpath
      .split('/')
      .map((p) => p.trim())
      .filter(Boolean);

    // In SiYuan, `hpath` is typically "/<notebook>/<path...>".
    return parts.length > 0 ? parts[0] : null;
  }

  shouldSkipIndex(doc) {
    if (!this.excludedNotebookNames || this.excludedNotebookNames.size === 0) {
      return false;
    }
    const notebookName = this.getNotebookNameFromDoc(doc);
    if (!notebookName) return false;
    return this.excludedNotebookNames.has(notebookName);
  }

  /**
   * Initialize database tables
   */
  initializeTables() {
    // Document registry table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS doc_registry (
        doc_id TEXT PRIMARY KEY,
        title TEXT,
        hpath TEXT,
        updated_at TEXT,
        indexed_at TEXT DEFAULT CURRENT_TIMESTAMP,
        deleted INTEGER DEFAULT 0,
        deleted_at TEXT,
        tags TEXT
      )
    `);

    // FTS5 full-text search table
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS block_fts USING fts5(
        block_id UNINDEXED,
        doc_id UNINDEXED,
        content,
        tokenize = 'porter unicode61'
      )
    `);

    // Sync metadata table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_metadata (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_doc_updated
      ON doc_registry(updated_at DESC)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_doc_deleted
      ON doc_registry(deleted, deleted_at)
    `);
  }

  /**
   * Index a document with its blocks
   * @param {object} doc - Document to index
   */
  indexDocument(doc) {
    if (doc?.id && this.shouldSkipIndex(doc)) {
      console.log(
        `[IndexManager] Skip indexing doc ${doc.id} (notebook: ${this.getNotebookNameFromDoc(doc) || "unknown"})`,
      );
      return;
    }

    const transaction = this.db.transaction(() => {
      // Upsert document metadata
      this.db.prepare(`
        INSERT INTO doc_registry (doc_id, title, hpath, updated_at, tags)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(doc_id) DO UPDATE SET
          title = excluded.title,
          hpath = excluded.hpath,
          updated_at = excluded.updated_at,
          tags = excluded.tags,
          indexed_at = CURRENT_TIMESTAMP,
          deleted = 0,
          deleted_at = NULL
      `).run(
        doc.id,
        doc.title || '',
        doc.hpath || '',
        doc.updated || new Date().toISOString(),
        doc.tags ? JSON.stringify(doc.tags) : null
      );

      // Delete old FTS entries for this document
      this.db.prepare('DELETE FROM block_fts WHERE doc_id = ?').run(doc.id);

      // Index document content as a block
      if (doc.content) {
        this.db.prepare(`
          INSERT INTO block_fts (block_id, doc_id, content)
          VALUES (?, ?, ?)
        `).run(doc.id, doc.id, doc.content);
      }

      // Index individual blocks if provided
      if (doc.blocks && Array.isArray(doc.blocks)) {
        const insertBlock = this.db.prepare(`
          INSERT INTO block_fts (block_id, doc_id, content)
          VALUES (?, ?, ?)
        `);

        for (const block of doc.blocks) {
          if (block.content) {
            insertBlock.run(block.id, doc.id, block.content);
          }
        }
      }
    });

    transaction();
  }

  /**
   * Remove a document from local index (best-effort cleanup if it was previously indexed).
   * This is used for excluded notebooks where we want "no traces" in doc_registry/block_fts.
   * @param {string} docId
   */
  removeFromIndex(docId) {
    if (!docId) return;

    const transaction = this.db.transaction(() => {
      // Remove any FTS entries first.
      this.db.prepare('DELETE FROM block_fts WHERE doc_id = ?').run(docId);

      // Remove registry entry as well ("no traces" policy).
      this.db.prepare('DELETE FROM doc_registry WHERE doc_id = ?').run(docId);
    });

    transaction();
  }

  /**
   * Search indexed content
   * @param {string} query - Search query
   * @param {object} options - Search options
   * @returns {Array} Search results
   */
  search(query, options = {}) {
    const limit = options.limit || 20;

    try {
      // FTS5 search with ranking
      const results = this.db.prepare(`
        SELECT
          block_fts.doc_id,
          block_fts.block_id,
          block_fts.content,
          doc_registry.title,
          doc_registry.hpath,
          doc_registry.updated_at,
          rank
        FROM block_fts
        JOIN doc_registry ON block_fts.doc_id = doc_registry.doc_id
        WHERE block_fts MATCH ?
          AND doc_registry.deleted = 0
        ORDER BY rank
        LIMIT ?
      `).all(query, limit);

      return results;
    } catch (error) {
      console.warn('[IndexManager] FTS search failed:', error.message);
      return [];
    }
  }

  /**
   * Sync multiple documents in batch
   * @param {Array} docs - Documents to sync
   */
  syncDocuments(docs) {
    const transaction = this.db.transaction(() => {
      for (const doc of docs) {
        this.indexDocument(doc);
      }
    });

    transaction();
  }

  /**
   * Mark document as deleted
   * @param {string} docId - Document ID
   */
  markDeleted(docId) {
    this.db.prepare(`
      UPDATE doc_registry
      SET deleted = 1, deleted_at = CURRENT_TIMESTAMP
      WHERE doc_id = ?
    `).run(docId);
  }

  /**
   * Update last sync timestamp
   * @param {string} timestamp - ISO timestamp
   */
  updateSyncTime(timestamp) {
    this.db.prepare(`
      INSERT INTO sync_metadata (key, value, updated_at)
      VALUES ('last_sync_time', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(timestamp);
  }

  /**
   * Get last sync timestamp
   * @returns {string|null} ISO timestamp
   */
  getLastSyncTime() {
    const result = this.db.prepare(
      "SELECT value FROM sync_metadata WHERE key = 'last_sync_time'"
    ).get();

    return result?.value || null;
  }

  /**
   * Get index statistics
   * @returns {object} Statistics
   */
  getStatistics() {
    const docCount = this.db.prepare(
      'SELECT COUNT(*) as count FROM doc_registry WHERE deleted = 0'
    ).get().count;

    const blockCount = this.db.prepare(
      'SELECT COUNT(*) as count FROM block_fts'
    ).get().count;

    const lastSync = this.getLastSyncTime();

    return {
      totalDocs: docCount,
      totalBlocks: blockCount,
      lastSync,
      dbPath: this.dbPath,
    };
  }

  /**
   * Clean up old deleted documents
   * @param {number} daysOld - Days threshold
   */
  cleanupOldDeleted(daysOld = 30) {
    const transaction = this.db.transaction(() => {
      // Get IDs to delete
      const toDelete = this.db.prepare(`
        SELECT doc_id FROM doc_registry
        WHERE deleted = 1
          AND deleted_at < datetime('now', '-' || ? || ' days')
      `).all(daysOld);

      if (toDelete.length === 0) {
        return;
      }

      const docIds = toDelete.map(row => row.doc_id);

      // Delete from FTS
      const deleteFts = this.db.prepare(
        'DELETE FROM block_fts WHERE doc_id = ?'
      );

      for (const docId of docIds) {
        deleteFts.run(docId);
      }

      // Delete from registry
      this.db.prepare(`
        DELETE FROM doc_registry
        WHERE deleted = 1
          AND deleted_at < datetime('now', '-' || ? || ' days')
      `).run(daysOld);
    });

    transaction();
  }

  /**
   * Get document by ID
   * @param {string} docId - Document ID
   * @returns {object|null} Document info
   */
  getDocument(docId) {
    return this.db.prepare(
      'SELECT * FROM doc_registry WHERE doc_id = ? AND deleted = 0'
    ).get(docId);
  }

  /**
   * Close database connection
   */
  close() {
    if (this.db) {
      this.db.close();
    }
  }
}
