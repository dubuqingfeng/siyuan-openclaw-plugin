/**
 * Index synchronization orchestration between SiYuan and the local IndexManager.
 *
 * Keeps IndexManager focused on local SQLite/FTS concerns; all remote fetch/query,
 * batching, and exclusion policy lives here.
 */

function parseSectionHeadingLevels(value) {
  const raw = Array.isArray(value) ? value : value == null ? null : [value];
  if (!raw) return new Set();

  const out = new Set();
  for (const v of raw) {
    if (typeof v === "number" && Number.isFinite(v)) {
      const n = Math.trunc(v);
      if (n >= 1 && n <= 6) out.add(n);
      continue;
    }
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (!s) continue;
      const m = s.match(/^h([1-6])$/);
      if (m) {
        out.add(Number(m[1]));
        continue;
      }
      const n = Number(s);
      if (Number.isFinite(n)) {
        const nn = Math.trunc(n);
        if (nn >= 1 && nn <= 6) out.add(nn);
      }
    }
  }
  return out;
}

function normalizeLineForDedup(line) {
  // Treat "1. xxx" and "xxx" as duplicates, likewise for "- xxx".
  // Keep this conservative to avoid deleting genuinely different lines.
  let s = String(line || "").trim();
  if (!s) return "";
  s = s
    .replace(/^\d+\s*[.)]\s+/, "") // "1. " / "1) "
    .replace(/^[-*+]\s+/, "") // "- " / "* " / "+ "
    .replace(/^（\d+）\s+/, "") // "（1） "
    .replace(/^\(\d+\)\s+/, ""); // "(1) "
  return s.trim();
}

export function sanitizeKramdown(text) {
  const t = String(text || "");
  if (!t.trim()) return "";

  // 1) Remove standalone kramdown attribute lines like `{: id="..."}`.
  // 2) Remove inline attribute blobs like `{: id="..."}` inside list/paragraph lines.
  return t
    .split(/\r?\n/)
    .filter((line) => !/^\s*\{:\s*[^}]*\}\s*$/.test(line))
    .map((line) => line.replace(/\{\:\s*[^}]*\}/g, "").replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}

function makeWindowDeduper(windowSize) {
  const size = Math.max(0, Number(windowSize ?? 0));
  if (!Number.isFinite(size) || size <= 0) {
    return {
      seen: () => false,
      add: () => {},
      reset: () => {},
    };
  }

  /** @type {string[]} */
  const queue = [];
  /** @type {Map<string, number>} */
  const counts = new Map();

  return {
    seen(norm) {
      return counts.has(norm);
    },
    add(norm) {
      queue.push(norm);
      counts.set(norm, (counts.get(norm) || 0) + 1);
      while (queue.length > size) {
        const old = queue.shift();
        const c = counts.get(old) || 0;
        if (c <= 1) counts.delete(old);
        else counts.set(old, c - 1);
      }
    },
    reset() {
      queue.length = 0;
      counts.clear();
    },
  };
}

export function buildSectionEntriesFromMarkdown(markdown, config, docIdForSyntheticIds = "") {
  const levels = parseSectionHeadingLevels(config?.index?.sectionHeadingLevels);
  if (levels.size === 0) return [];

  const maxSectionsToIndex = Math.max(
    0,
    Number(config?.index?.maxSectionsToIndex ?? 80),
  );
  const sectionMaxChars = Math.max(
    200,
    Number(config?.index?.sectionMaxChars ?? 1200),
  );

  const dedupLines = config?.index?.sectionDedupLines ?? true;
  const windowSize = Number(config?.index?.sectionDedupWindowSize ?? 200);
  const deduper = makeWindowDeduper(windowSize);

  const md = String(markdown || "");
  if (!md.trim()) return [];

  const sections = [];
  let current = null; // { id, level, title, bodyLines: [] }
  let lastLine = "";
  let lastNorm = "";

  const flush = () => {
    if (!current) return;
    const heading = `${"#".repeat(current.level)} ${current.title}`.trim();
    let content = heading;
    const body = current.bodyLines.join("\n").trim();
    if (body) content += `\n${body}`;
    if (content.length > sectionMaxChars) {
      content = content.slice(0, sectionMaxChars - 3).trimEnd() + "...";
    }
    sections.push({ id: current.id, content });
  };

  const lines = md.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = String(raw || "").trim();
    if (!line) continue;

    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) {
      const level = m[1].length;
      if (levels.has(level)) {
        flush();
        deduper.reset();
        lastLine = "";
        lastNorm = "";
        const title = m[2].trim();
        const id = docIdForSyntheticIds
          ? `${docIdForSyntheticIds}::h${level}::${i}`
          : `h${level}::${i}`;
        current = { id, level, title, bodyLines: [] };
        if (maxSectionsToIndex > 0 && sections.length >= maxSectionsToIndex) break;
        continue;
      }
    }

    if (!current) continue;

    if (!dedupLines) {
      current.bodyLines.push(line);
      continue;
    }

    const n = normalizeLineForDedup(line);
    if (!n) continue;
    if (n === lastNorm || line === lastLine) continue;
    if (deduper.seen(n)) continue;
    current.bodyLines.push(line);
    lastLine = line;
    lastNorm = n;
    deduper.add(n);
  }

  flush();
  return maxSectionsToIndex > 0 ? sections.slice(0, maxSectionsToIndex) : [];
}

function buildDocContentFromMarkdown(markdown, config) {
  const dedupLines = config?.index?.docContentDedupLines ?? true;
  const windowSize = Number(config?.index?.docContentDedupWindowSize ?? 400);
  const deduper = makeWindowDeduper(windowSize);

  const md = String(markdown || "");
  if (!md.trim()) return "";
  if (!dedupLines) return md.trim();

  const out = [];
  let lastLine = "";
  let lastNorm = "";
  for (const raw of md.split(/\r?\n/)) {
    const line = String(raw || "").trim();
    if (!line) continue;
    const n = normalizeLineForDedup(line);
    if (!n) continue;
    if (n === lastNorm || line === lastLine) continue;
    if (deduper.seen(n)) continue;
    out.push(line);
    lastLine = line;
    lastNorm = n;
    deduper.add(n);
  }
  return out.join("\n");
}

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

            const data = await this.siyuanClient.getBlockKramdown(docId);
            const kramdown = sanitizeKramdown(data?.kramdown || "");
            const docContent = buildDocContentFromMarkdown(kramdown, this.config);
            const sectionEntries = buildSectionEntriesFromMarkdown(
              kramdown,
              this.config,
              docId,
            );

            docsToSync.push({
              id: docId,
              title: doc?.content || "Untitled",
              hpath: doc?.hpath,
              notebookName: notebook?.name,
              notebookId: doc?.box || notebook?.id,
              content: docContent,
              blocks: sectionEntries,
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

          const data = await this.siyuanClient.getBlockKramdown(docId);
          const kramdown = sanitizeKramdown(data?.kramdown || "");
          const docContent = buildDocContentFromMarkdown(kramdown, this.config);
          const sectionEntries = buildSectionEntriesFromMarkdown(
            kramdown,
            this.config,
            docId,
          );

          docsToSync.push({
            id: docId,
            title: docRow.content || "Untitled",
            hpath: docRow.hpath,
            notebookId: docRow?.box,
            notebookName: this.notebookIdToNameCache?.get(docRow?.box),
            content: docContent,
            blocks: sectionEntries,
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
