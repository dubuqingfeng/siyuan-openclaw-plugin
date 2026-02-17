/**
 * Index synchronization orchestration between SiYuan and the local IndexManager.
 *
 * Keeps IndexManager focused on local SQLite/FTS concerns; all remote fetch/query,
 * batching, and exclusion policy lives here.
 */
export class IndexSyncService {
  /**
   * @param {object} deps
   * @param {import("../clients/siyuan-client.js").SiYuanClient} deps.siyuanClient
   * @param {import("../infra/index-manager.js").IndexManager} deps.indexManager
   * @param {object} deps.config
   */
  constructor({ siyuanClient, indexManager, config }) {
    this.siyuanClient = siyuanClient;
    this.indexManager = indexManager;
    this.config = config;

    this.notebookIdToNameCache = null; // Map<string, string>
    this.excludedNotebookNamesCache = new Set(); // Set<string>
    this.excludedNotebookIdsCache = new Set(); // Set<string>

    this._timerId = null;
  }

  getExcludedNotebookNamesFromConfig() {
    const cfg = this.config;
    return new Set(
      [cfg?.index?.privacyNotebook, cfg?.index?.archiveNotebook]
        .concat(
          Array.isArray(cfg?.index?.skipNotebookNames)
            ? cfg.index.skipNotebookNames
            : [],
        )
        .map((n) => String(n || "").trim())
        .filter(Boolean)
        .map((n) => n.replace(/^\/+|\/+$/g, "")),
    );
  }

  async refreshNotebookCache() {
    const notebooks = await this.siyuanClient.listNotebooks();
    const list = Array.isArray(notebooks) ? notebooks : [];

    const map = new Map(list.filter((n) => n && n.id).map((n) => [n.id, n.name]));

    this.notebookIdToNameCache = map;
    this.excludedNotebookNamesCache = this.getExcludedNotebookNamesFromConfig();
    this.excludedNotebookIdsCache = new Set(
      list
        .filter((n) => this.excludedNotebookNamesCache.has(n?.name))
        .map((n) => n.id)
        .filter(Boolean),
    );
  }

  startBackgroundSync() {
    const intervalMs = this.config.index?.syncIntervalMs || 5 * 60 * 1000;

    if (this._timerId) {
      clearInterval(this._timerId);
    }

    this._timerId = setInterval(async () => {
      try {
        await this.performIncrementalSync();
      } catch (error) {
        console.error("[OpenClaw SiYuan] Sync failed:", error?.message || error);
      }
    }, intervalMs);

    console.log(
      `[OpenClaw SiYuan] Background sync started (interval: ${intervalMs}ms)`,
    );
  }

  stopBackgroundSync() {
    if (!this._timerId) return;
    clearInterval(this._timerId);
    this._timerId = null;
  }

  /**
   * Perform initial full index sync.
   * Note: caller is responsible for ensuring SiYuan is available.
   */
  async performInitialSync() {
    const { indexManager } = this;
    if (!indexManager) return;

    const lastSync = indexManager.getLastSyncTime();
    if (lastSync) {
      console.log(
        "[OpenClaw SiYuan] Index already initialized, skipping full sync",
      );
      return;
    }

    try {
      console.log("[OpenClaw SiYuan] Starting initial index sync...");

      const escapeSqlString = (s) => String(s ?? "").replace(/'/g, "''");
      const maxBlocksForDocContent = Math.max(
        1,
        Number(this.config.index?.maxBlocksForDocContent ?? 2000),
      );
      const maxBlocksToIndex = Math.max(
        1,
        Number(this.config.index?.maxBlocksToIndex ?? 600),
      );
      const excludedNotebookNames = this.getExcludedNotebookNamesFromConfig();
      const sqlPageSize = Math.max(
        1,
        Number(this.config.index?.sqlPageSize ?? 200),
      );

      // Get all notebooks
      const notebooks = await this.siyuanClient.listNotebooks();

      let totalDocs = 0;

      for (const notebook of notebooks) {
        // Skip indexing whole notebook by name (more reliable than inferring from hpath).
        if (
          excludedNotebookNames.size > 0 &&
          excludedNotebookNames.has(notebook?.name)
        ) {
          console.log(
            `[OpenClaw SiYuan] Skip indexing notebook: ${notebook.name}`,
          );
          continue;
        }

        // Query documents in notebook in pages. SiYuan /api/query/sql may apply an implicit cap.
        let offset = 0;
        let notebookDocCount = 0;
        while (true) {
          const rows = await this.siyuanClient.query(`
            SELECT id, content, hpath, updated, box
            FROM blocks
            WHERE type = 'd'
              AND box = '${escapeSqlString(notebook.id)}'
            ORDER BY updated DESC
            LIMIT ${sqlPageSize} OFFSET ${offset}
          `);

          const docs = Array.isArray(rows) ? rows : [];
          if (docs.length === 0) break;

          const docsToSync = [];

          for (const doc of docs) {
            const docId = doc?.id;
            if (!docId) continue;

            // Build doc-level content from its blocks; doc block `content` is usually title only.
            const blocksRows = await this.siyuanClient.query(`
              SELECT id, content, updated
              FROM blocks
              WHERE root_id = '${escapeSqlString(docId)}'
                AND type != 'd'
                AND content IS NOT NULL
                AND TRIM(content) != ''
              ORDER BY updated ASC
              LIMIT ${maxBlocksForDocContent}
            `);
            const blocks = Array.isArray(blocksRows) ? blocksRows : [];

            const docContent = blocks
              .map((b) =>
                typeof b?.content === "string" ? b.content.trim() : "",
              )
              .filter(Boolean)
              .join("\n");

            docsToSync.push({
              id: docId,
              title: doc?.content || "Untitled",
              hpath: doc?.hpath,
              notebookName: notebook?.name,
              notebookId: doc?.box || notebook?.id,
              content: docContent,
              blocks: blocks.slice(-maxBlocksToIndex).map((b) => ({
                id: b.id,
                content: b.content,
                updated: b.updated,
              })),
              updated: doc?.updated,
            });
          }

          if (docsToSync.length > 0) {
            indexManager.syncDocuments(docsToSync);
          }

          notebookDocCount += docs.length;
          totalDocs += docs.length;
          offset += docs.length;

          if (docs.length < sqlPageSize) break;
        }

        if (notebookDocCount > 0) {
          console.log(
            `[OpenClaw SiYuan] Initial sync: notebook ${notebook?.name || notebook?.id} indexed ${notebookDocCount} docs`,
          );
        }
      }

      indexManager.updateSyncTime(new Date().toISOString());
      console.log(
        `[OpenClaw SiYuan] Initial sync complete: ${totalDocs} documents indexed`,
      );
    } catch (error) {
      console.error("[OpenClaw SiYuan] Initial sync failed:", error?.message || error);
    }
  }

  /**
   * Perform incremental index synchronization.
   * Note: caller is responsible for ensuring SiYuan is available.
   */
  async performIncrementalSync() {
    const { indexManager } = this;
    if (!indexManager) return;

    const lastSync = indexManager.getLastSyncTime();
    if (!lastSync) {
      console.log("[OpenClaw SiYuan] No previous sync, running initial sync");
      await this.performInitialSync();
      return;
    }

    const syncTime = new Date().toISOString();

    try {
      const escapeSqlString = (s) => String(s ?? "").replace(/'/g, "''");
      const maxBlocksForDocContent = Math.max(
        1,
        Number(this.config.index?.maxBlocksForDocContent ?? 200),
      );
      const maxBlocksToIndex = Math.max(
        1,
        Number(this.config.index?.maxBlocksToIndex ?? 60),
      );

      // Refresh caches best-effort; exclusion should still work by notebookId if cache exists.
      if (!this.notebookIdToNameCache || this.notebookIdToNameCache.size === 0) {
        try {
          await this.refreshNotebookCache();
        } catch {
          // best effort
        }
      }

      // Get updated blocks since last sync
      const updatedBlocks = await this.siyuanClient.getUpdatedBlocks(lastSync);

      if (updatedBlocks.length > 0) {
        // Determine which documents are affected, then rebuild doc-level content for each.
        const docIds = Array.from(
          new Set(updatedBlocks.map((b) => b.root_id || b.id).filter(Boolean)),
        );

        const docsToSync = [];

        for (const docId of docIds) {
          const docRows = await this.siyuanClient.query(`
            SELECT id, content, hpath, updated, box
            FROM blocks
            WHERE type = 'd'
              AND id = '${escapeSqlString(docId)}'
            LIMIT 1
          `);

          const docRow = docRows[0];
          if (!docRow) {
            // Doc might be deleted; mark as deleted in local index (best effort).
            try {
              indexManager.markDeleted(docId);
            } catch {
              // ignore
            }
            continue;
          }

          // Strong exclusion: if the document lives in an excluded notebook id, never index it.
          // NOTE: we don't mutate local index state here (no delete/mark), we simply skip.
          if (docRow?.box && this.excludedNotebookIdsCache?.has(docRow.box)) {
            continue;
          }

          const blocks = await this.siyuanClient.query(`
            SELECT id, content, updated
            FROM blocks
            WHERE root_id = '${escapeSqlString(docId)}'
              AND type != 'd'
              AND content IS NOT NULL
              AND TRIM(content) != ''
            ORDER BY updated ASC
            LIMIT ${maxBlocksForDocContent}
          `);

          const docContent = blocks
            .map((b) =>
              typeof b?.content === "string" ? b.content.trim() : "",
            )
            .filter(Boolean)
            .join("\n");

          docsToSync.push({
            id: docId,
            title: docRow.content || "Untitled",
            hpath: docRow.hpath,
            notebookId: docRow?.box,
            notebookName: this.notebookIdToNameCache?.get(docRow?.box),
            content: docContent,
            blocks: blocks.slice(-maxBlocksToIndex).map((b) => ({
              id: b.id,
              content: b.content,
              updated: b.updated,
            })),
            updated: docRow.updated,
          });
        }

        if (docsToSync.length > 0) {
          // Sync all updated documents
          indexManager.syncDocuments(docsToSync);
        }

        console.log(
          `[OpenClaw SiYuan] Incremental sync: ${updatedBlocks.length} blocks updated`,
        );
      }

      indexManager.updateSyncTime(syncTime);
    } catch (error) {
      console.error(
        "[OpenClaw SiYuan] Incremental sync failed:",
        error?.message || error,
      );
    }
  }
}

