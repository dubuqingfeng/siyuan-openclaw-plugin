/**
 * Memory recall system for retrieving relevant notes before AI response
 */
import { sanitizeKramdown } from "./index-sync.js";

export class MemoryRecall {
  /**
   * @param {object} siyuanClient - SiYuan API client
   * @param {object} config - Plugin configuration
   * @param {object} indexManager - Local index manager (optional)
   */
  constructor(siyuanClient, config, indexManager = null) {
    this.client = siyuanClient;
    this.config = config;
    this.indexManager = indexManager;
  }

  /**
   * Main recall entry point
   * @param {string} prompt - User prompt
   * @returns {Promise<object>} Recall result with prepend context
   */
  async recall(prompt) {
    const minLength = this.config.recall?.minPromptLength || 10;

    const linkedDocIds = this.extractLinkedDocIds(prompt);

    const recallEnabled = this.config?.recall?.enabled ?? true;
    const linkedDocEnabled = this.getLinkedDocConfig().enabled;

    // Allow `linkedDoc` injection even when `recall.enabled=false`.
    // In that mode, we ONLY fetch/inject linked docs (no search).
    if (!recallEnabled) {
      const text = (typeof prompt === "string" ? prompt : "").trim();

      // Respect explicit skip commands even for linked-doc injection.
      if (this.isRecallSkipCommand(text)) {
        return {
          prependContext: "",
          recalledDocs: [],
          skipped: true,
          reason: "explicit_skip",
        };
      }

      if (!linkedDocEnabled || linkedDocIds.length === 0) {
        return {
          prependContext: "",
          recalledDocs: [],
          skipped: true,
          reason: "recall_disabled",
        };
      }

      const linkedDocs = await this.fetchLinkedDocs(linkedDocIds);
      if (linkedDocs.length === 0) {
        return {
          prependContext: "",
          recalledDocs: [],
          error: "No results found",
        };
      }

      const maxDocsRaw = this.config.recall?.maxDocs;
      const maxDocs = Number.isFinite(Number(maxDocsRaw))
        ? Math.max(1, Number(maxDocsRaw))
        : null;
      const limitedDocs = maxDocs ? linkedDocs.slice(0, maxDocs) : linkedDocs;

      return {
        prependContext: this.formatContext(limitedDocs),
        recalledDocs: limitedDocs,
        linkedDocs: limitedDocs,
        intent: { type: "linked_doc", keywords: [], timeRange: null },
      };
    }

    const gate = this.shouldRecall(prompt, minLength, {
      hasLinkedDoc: linkedDocIds.length > 0,
    });
    if (!gate.should) {
      return {
        prependContext: "",
        recalledDocs: [],
        skipped: true,
        reason: gate.reason,
      };
    }

    try {
      const rawSearchPrompt = this.isRecallForceCommand(prompt)
        ? this.stripRecallCommandPrefix(prompt)
        : prompt;

      const linkedDocs = await this.fetchLinkedDocs(linkedDocIds);
      const searchPrompt = this.stripLinkedDocUrls(rawSearchPrompt);

      // Step 1: Analyze intent
      const intent = this.analyzeIntent(searchPrompt);

      // Step 2: Multi-path search
      const blocks = searchPrompt.trim()
        ? await this.search(searchPrompt, intent)
        : [];

      if (blocks.length === 0 && linkedDocs.length === 0) {
        return {
          prependContext: "",
          recalledDocs: [],
          error: "No results found",
        };
      }

      // Step 3: Aggregate and rank results
      const rankedDocs =
        blocks.length > 0 ? this.aggregateResults(blocks, intent.keywords) : [];
      const mergedDocs = this.mergeDocs(linkedDocs, rankedDocs);

      // Step 4: Format as context
      const maxDocsRaw = this.config.recall?.maxDocs;
      const maxDocs = Number.isFinite(Number(maxDocsRaw))
        ? Math.max(1, Number(maxDocsRaw))
        : null;
      const limitedDocs = maxDocs ? mergedDocs.slice(0, maxDocs) : mergedDocs;

      const context = this.formatContext(limitedDocs);

      return {
        prependContext: context,
        recalledDocs: limitedDocs,
        intent,
        linkedDocs: linkedDocs.length > 0 ? linkedDocs : undefined,
      };
    } catch (error) {
      console.error("[MemoryRecall] Recall failed:", error.message);

      // If all search paths fail, still return error info
      return {
        prependContext: "",
        recalledDocs: [],
        error: error.message || "Unknown error",
      };
    }
  }

  /**
   * Analyze user intent and extract query parameters
   * @param {string} prompt - User prompt
   * @returns {object} Intent analysis result
   */
  analyzeIntent(prompt) {
    const keywords = this.extractKeywords(prompt);
    const timeRange = this.extractTimeRange(prompt);
    const type = this.detectIntentType(prompt);

    return {
      keywords,
      timeRange,
      type,
    };
  }

  normalizeQuery(query) {
    const q = (typeof query === "string" ? query : "").trim();
    if (!q) return "";
    // Keep original language, but normalize whitespace and strip noisy punctuation.
    return q
      .replace(/\s+/g, " ")
      .replace(/[^\p{L}\p{N}\s\u4e00-\u9fa5]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  clampKeywordCount(words) {
    const maxKeywords = this.config.recall?.maxKeywords ?? 12;
    if (!Array.isArray(words) || words.length <= maxKeywords)
      return words || [];
    return words.slice(0, maxKeywords);
  }

  /**
   * Extract keywords from prompt
   * @param {string} text - Input text
   * @returns {string[]} Extracted keywords
   */
  extractKeywords(text) {
    const stopWords = [
      "的",
      "了",
      "是",
      "在",
      "有",
      "和",
      "我",
      "你",
      "他",
      "这",
      "那",
      "个",
      "帮",
      "请",
      "通过",
      "一下",
      "关于",
      "上周",
      "回顾",
      // Query framing phrases (often appear in "search my notes ..." prompts)
      "找笔记",
      "查笔记",
      "查一下",
      "告诉我",
      "帮我",
      "the",
      "is",
      "are",
      "was",
      "were",
      "a",
      "an",
      "and",
      "or",
      "but",
      "tell",
      "me",
      "about",
      "help",
      "please",
    ];

    const normalized = this.normalizeQuery(text);

    // For CJK keyword extraction, treat common particles/framing phrases as separators so we
    // don't end up with one long span like "告诉我张三的简历".
    const normalizedForCJK = normalized
      .replace(/(告诉我|帮我|麻烦|请|的)/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // Extract Chinese spans (2+ characters). These are usually higher-signal than overlapping bigrams.
    const chineseWords = normalizedForCJK.match(/[\u4e00-\u9fa5]{2,}/g) || [];

    // Optional: add a small number of 2-char bigrams only when Chinese spans are long
    // (helps recall without flooding the keyword set with noise).
    const splitChineseWords = [];
    for (const chunk of chineseWords) {
      if (chunk.length < 5) continue;
      for (
        let i = 0;
        i < chunk.length - 1 && splitChineseWords.length < 20;
        i++
      ) {
        splitChineseWords.push(chunk.substring(i, i + 2));
      }
    }

    // Extract English/alphanumeric words
    const words = normalized
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      // Keep this for Latin/alnum tokens; CJK spans are handled separately above.
      .filter(
        (word) =>
          word.length > 1 &&
          !stopWords.includes(word) &&
          !/[\u4e00-\u9fa5]/.test(word),
      );

    // Combine all
    const allWords = [...chineseWords, ...splitChineseWords, ...words]
      .map((w) => (typeof w === "string" ? w.trim() : ""))
      .filter((word) => word.length > 1 && !stopWords.includes(word));

    const isCJKWord = (w) => /^[\u4e00-\u9fa5]{2,}$/.test(w);

    // Prefer longer tokens first; remove tokens that are contained by longer ones.
    // NOTE: do NOT drop CJK tokens by containment. A longer Chinese span can contain
    // the real entity name/topic (e.g. "告诉我张三的简历"), and dropping sub-tokens
    // kills recall precision.
    const unique = [...new Set(allWords)].sort((a, b) => b.length - a.length);
    const filtered = [];
    for (const w of unique) {
      const isCJK2 = /^[\u4e00-\u9fa5]{2}$/.test(w);
      if (!isCJKWord(w) && !isCJK2 && filtered.some((kept) => kept.includes(w)))
        continue;
      filtered.push(w);
    }

    return this.clampKeywordCount(filtered);
  }

  /**
   * Extract time range from prompt
   * @param {string} prompt - User prompt
   * @returns {object|null} Time range info
   */
  extractTimeRange(prompt) {
    const patterns = {
      上周: 7,
      最近一周: 7,
      "last week": 7,
      这周: 7,
      "this week": 7,
      昨天: 1,
      yesterday: 1,
      今天: 1,
      today: 1,
      最近: 30,
      recent: 30,
    };

    for (const [pattern, days] of Object.entries(patterns)) {
      if (prompt.toLowerCase().includes(pattern)) {
        return {
          days,
          pattern,
          since: this.getDaysAgo(days),
        };
      }
    }

    return null;
  }

  /**
   * Get date N days ago
   * @param {number} days - Number of days
   * @returns {string} ISO date string
   */
  getDaysAgo(days) {
    const date = new Date();
    date.setDate(date.getDate() - days);
    return date.toISOString().split("T")[0];
  }

  /**
   * Detect intent type
   * @param {string} prompt - User prompt
   * @returns {string} Intent type
   */
  detectIntentType(prompt) {
    const lower = prompt.toLowerCase();

    if (this.isGreeting(prompt)) {
      return "chat";
    }

    // Treat slash-prefixed messages as commands (usually not knowledge queries)
    if (lower.trim().startsWith("/")) {
      return "command";
    }

    if (
      lower.includes("回顾") ||
      lower.includes("review") ||
      lower.includes("总结") ||
      lower.includes("summary")
    ) {
      return "review";
    }

    if (
      lower.includes("查找") ||
      lower.includes("search") ||
      lower.includes("找") ||
      lower.includes("find")
    ) {
      return "search";
    }

    return "query";
  }

  /**
   * Decide whether to run recall for a prompt.
   * This avoids unnecessary SiYuan queries for greetings/small-talk or explicit skip commands.
   * @param {string} prompt
   * @param {number} minLength
   * @param {object} opts
   * @param {boolean} opts.hasLinkedDoc
   * @returns {{should: boolean, reason: string}}
   */
  shouldRecall(prompt, minLength = 10, opts = {}) {
    const text = (typeof prompt === "string" ? prompt : "").trim();
    console.log("[Openclaw siyuan] prompt", text);

    // Explicit user control
    if (this.isRecallSkipCommand(text)) {
      return { should: false, reason: "explicit_skip" };
    }
    if (this.isRecallForceCommand(text)) {
      return { should: true, reason: "explicit_force" };
    }

    // If user pasted a SiYuan share/app link (with a block/doc id), allow recall even for short prompts.
    if (opts?.hasLinkedDoc) {
      return { should: true, reason: "linked_doc" };
    }

    if (!text || text.length < minLength) {
      return { should: false, reason: "too_short" };
    }

    // Skip greetings/small-talk even if long enough
    if (this.isGreeting(text)) {
      return { should: false, reason: "greeting" };
    }

    // Optional: allow skipping by intent types
    const skipTypes = this.config.recall?.skipIntentTypes || [
      "chat",
      "command",
    ];
    const type = this.detectIntentType(text);
    if (skipTypes.includes(type)) {
      return { should: false, reason: `intent_${type}` };
    }

    return { should: true, reason: "default" };
  }

  getLinkedDocConfig() {
    // Preferred: top-level `linkedDoc`. Legacy: `recall.linkedDoc`.
    const cfg = this.config?.linkedDoc ?? this.config?.recall?.linkedDoc;
    const enabled = cfg?.enabled ?? true;
    const hostKeywords = Array.isArray(cfg?.hostKeywords)
      ? cfg.hostKeywords.map((x) => String(x || "").trim()).filter(Boolean)
      : [];
    const maxCountRaw = cfg?.maxCount;
    const maxCount = Number.isFinite(Number(maxCountRaw))
      ? Math.max(1, Number(maxCountRaw))
      : 3;
    return { enabled, hostKeywords, maxCount };
  }

  isAllowedLinkedDocUrl(urlString) {
    const { enabled, hostKeywords } = this.getLinkedDocConfig();
    if (!enabled) return false;
    if (!hostKeywords || hostKeywords.length === 0) return true;

    try {
      const u = new URL(urlString);
      const hay = `${u.hostname} ${u.host} ${u.href}`.toLowerCase();
      return hostKeywords.some((k) => hay.includes(String(k).toLowerCase()));
    } catch {
      // If it isn't a parseable URL, be conservative when hostKeywords are configured.
      return false;
    }
  }

  extractLinkedDocIds(text) {
    const { enabled, maxCount, hostKeywords } = this.getLinkedDocConfig();
    if (!enabled) return [];

    const raw = typeof text === "string" ? text : "";
    if (!raw.trim()) return [];

    // If a host/domain/IP allowlist is configured, require the prompt to mention at least one keyword.
    // This avoids accidentally treating other "id=..." parameters as SiYuan doc ids.
    if (hostKeywords.length > 0) {
      const hay = raw.toLowerCase();
      const ok = hostKeywords.some((k) =>
        hay.includes(String(k).toLowerCase()),
      );
      if (!ok) return [];
    }

    // SiYuan block/document id shape: 14 digits + '-' + 7 base36-ish chars.
    const idRe = /\b\d{14}-[a-z0-9]{7}\b/gi;

    /** @type {string[]} */
    const ids = [];

    // 1) Prefer extracting from URLs (avoids accidentally matching other "id=" parameters).
    const urlRe = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
    const urls = raw.match(urlRe) || [];
    for (const u0 of urls) {
      const u = String(u0 || "").trim();
      if (!u) continue;
      if (!this.isAllowedLinkedDocUrl(u)) continue;

      try {
        const parsed = new URL(u);
        const qid = parsed.searchParams.get("id") || "";
        const m = qid.match(idRe);
        if (m && m[0]) ids.push(m[0].toLowerCase());

        // Also allow `/.../20220802180638-xxxxxxx` style shares.
        const pathMatches = parsed.pathname.match(idRe) || [];
        for (const x of pathMatches) ids.push(String(x).toLowerCase());
      } catch {
        // Ignore parse failures
      }
    }

    // 2) Fallback: extract any standalone ids (e.g. user pasted the id directly).
    const loose = raw.match(idRe) || [];
    for (const x of loose) ids.push(String(x).toLowerCase());

    const unique = [...new Set(ids)].slice(0, maxCount);
    return unique;
  }

  stripLinkedDocUrls(text) {
    const raw = typeof text === "string" ? text : "";
    if (!raw.trim()) return raw;

    // Remove URLs that contain a SiYuan-style id, to prevent "47 94 239 ..." noise from polluting keywords.
    const urlRe = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
    return raw.replace(urlRe, (u0) => {
      const u = String(u0 || "");
      const ids = this.extractLinkedDocIds(u);
      return ids.length > 0 ? " " : u;
    });
  }

  async fetchLinkedDocs(ids) {
    const list = Array.isArray(ids) ? ids : [];
    if (list.length === 0) return [];
    if (!this.client || typeof this.client.getBlockKramdown !== "function")
      return [];

    const out = [];
    for (const id0 of list) {
      const id = String(id0 || "").trim();
      if (!id) continue;
      try {
        const data = await this.client.getBlockKramdown(id);
        const kramdown =
          typeof data?.kramdown === "string" ? data.kramdown : "";
        const markdown = sanitizeKramdown(kramdown);
        if (!markdown.trim()) continue;

        // Best-effort meta for display; do not fail the whole recall on this.
        let info = null;
        try {
          if (typeof this.client.getBlockInfo === "function") {
            info = await this.client.getBlockInfo(id);
          }
        } catch {
          info = null;
        }

        const path =
          info?.hpath ||
          info?.hPath ||
          info?.path ||
          info?.name ||
          `[linked:${id}]`;
        const updated =
          info?.updated ||
          info?.updatedAt ||
          info?.modified ||
          info?.created ||
          null;

        out.push({
          docId: id,
          path,
          updated,
          // Keep a separate field so formatter can include full markdown.
          markdown,
          // Provide a block so existing scoring/formatters can still operate if needed.
          blocks: [{ id, content: markdown, _score: 1, updated }],
          _source: "linked_doc",
          score: 1,
        });
      } catch (e) {
        console.warn(
          "[MemoryRecall] Failed to fetch linked doc:",
          id,
          e?.message,
        );
      }
    }
    return out;
  }

  mergeDocs(primary, secondary) {
    const a = Array.isArray(primary) ? primary : [];
    const b = Array.isArray(secondary) ? secondary : [];
    if (a.length === 0) return b;
    if (b.length === 0) return a;

    const seen = new Set();
    const out = [];
    const push = (d) => {
      if (!d) return;
      const id = d.docId || d.root_id || d.id;
      const key = String(id || "").trim();
      if (!key) {
        out.push(d);
        return;
      }
      if (seen.has(key)) return;
      seen.add(key);
      out.push(d);
    };

    for (const d of a) push(d);
    for (const d of b) push(d);
    return out;
  }

  /**
   * Basic greeting/small-talk detection for recall gating.
   * Keep this conservative: only match very common patterns.
   * @param {string} text
   * @returns {boolean}
   */
  isGreeting(text) {
    const t = (typeof text === "string" ? text : "").trim().toLowerCase();
    if (!t) return false;

    const exact = new Set([
      "你好",
      "您好",
      "hello",
      "hi",
      "hey",
      "嗨",
      "在吗",
      "在么",
      "谢谢",
      "thanks",
      "thank you",
      "ok",
      "okay",
      "好的",
      "嗯",
      "哦",
      "bye",
      "再见",
    ]);
    if (exact.has(t)) return true;

    // Common small-talk / capability questions
    const patterns = [
      /^你好[呀啊吗哇]?[，,！!。.]?/,
      /最近怎么样/,
      /你是谁/,
      /你能(做什么|干什么)/,
      /能帮我(做什么|干什么)/,
    ];
    return patterns.some((p) => p.test(t));
  }

  isRecallSkipCommand(text) {
    const t = (typeof text === "string" ? text : "").toLowerCase();
    const patterns = [
      "不用回忆",
      "不要回忆",
      "别回忆",
      "不用检索",
      "不要检索",
      "别检索",
      "不用查笔记",
      "不要查笔记",
      "别查笔记",
      "不用查思源",
      "不要查思源",
      "别查思源",
      "don't recall",
      "dont recall",
      "no recall",
      "no context",
      "don't add context",
    ];
    return patterns.some((p) => t.includes(p));
  }

  isRecallForceCommand(text) {
    const t = (typeof text === "string" ? text : "").toLowerCase();
    const patterns = this.getRecallForcePhrases();
    return patterns.some((p) => t.includes(p));
  }

  getRecallForcePhrases() {
    // Phrases that explicitly instruct the assistant to search SiYuan notes.
    // Also used for stripping command prefixes from the actual search query.
    return [
      "查一下我的笔记",
      "从笔记里找",
      "翻一下我的笔记",
      "找一下我的笔记",
      "在思源里找",
      "查思源",
      "找笔记",
      "search my notes",
      "look up my notes",
      "from my notes",
      "recall memory",
      "use my notes",
    ];
  }

  /**
   * Strip recall-force command prefix from the prompt so we search using only the real query.
   * Example: "查一下我的笔记：Rust ownership 是什么？" -> "Rust ownership 是什么？"
   * @param {string} text
   * @returns {string}
   */
  stripRecallCommandPrefix(text) {
    const original = typeof text === "string" ? text : "";
    const trimmed = original.trim();
    if (!trimmed) return original;

    // Fast path: strip if any force phrase appears near the beginning (users often write "通过 找笔记 ...").
    // Keep it conservative to avoid stripping when the phrase appears later in the sentence as content.
    const lower = trimmed.toLowerCase();
    for (const p of this.getRecallForcePhrases()) {
      const pl = String(p || "").toLowerCase();
      if (!pl) continue;
      const idx = lower.indexOf(pl);
      if (idx >= 0 && idx <= 6) {
        const after = trimmed
          .slice(idx + p.length)
          .replace(/^\s*(?:for|about|:|：|,|，|-)?\s*/i, "")
          .trim();
        return after || trimmed;
      }
    }

    const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const prefixes = this.getRecallForcePhrases().map(escapeRegex).join("|");

    // Only strip when the phrase appears at the start; keep mid-sentence occurrences intact.
    const re = new RegExp(
      `^\\s*(?:${prefixes})(?:\\s*(?:for|about|:|：|,|，|-)?\\s*)`,
      "i",
    );

    const stripped = trimmed.replace(re, "").trim();
    return stripped || trimmed;
  }

  /**
   * Multi-path search combining different search methods
   * @param {string} query - Search query
   * @param {object} intent - Intent analysis result
   * @returns {Promise<Array>} Combined search results
   */
  async search(query, intent) {
    const searchPaths = this.config.recall?.searchPaths || [
      "fulltext",
      "sql",
      "fts",
    ];
    const normalizedQuery = this.normalizeQuery(query);
    const keywords = intent?.keywords || this.extractKeywords(normalizedQuery);

    const twoStage = this.config.recall?.twoStage || {};
    const twoStageEnabled = twoStage.enabled ?? true;
    const candidateLimitPerPath = twoStage.candidateLimitPerPath ?? 80;
    const finalBlockLimit = twoStage.finalBlockLimit ?? 40;
    const perDocBlockCap = twoStage.perDocBlockCap ?? 6;

    const tasks = [];

    // Local FTS search (fastest, try first if available)
    if (searchPaths.includes("fts") && this.indexManager) {
      tasks.push(
        this.searchLocalFTS(normalizedQuery, {
          limit: twoStageEnabled ? candidateLimitPerPath : 20,
          keywords,
        }).then((rows) => rows.map((b) => this.normalizeBlock(b, "fts"))),
      );
    }

    // Full-text search via SiYuan API
    if (searchPaths.includes("fulltext")) {
      const options = twoStageEnabled
        ? {
            page: 1,
            size: candidateLimitPerPath,
            ...(twoStage.fulltextOptions || {}),
          }
        : {};
      tasks.push(
        this.searchFullText(normalizedQuery, options).then((rows) =>
          rows.map((b) => this.normalizeBlock(b, "fulltext")),
        ),
      );
    }

    // SQL search via SiYuan API
    if (searchPaths.includes("sql")) {
      tasks.push(
        this.searchSQL(normalizedQuery, intent?.timeRange, {
          limit: twoStageEnabled ? candidateLimitPerPath : 20,
          keywords,
        }).then((rows) => rows.map((b) => this.normalizeBlock(b, "sql"))),
      );
    }

    const settled = await Promise.allSettled(tasks);
    const results = [];
    for (const s of settled) {
      if (s.status === "fulfilled") {
        results.push(...(s.value || []));
      } else {
        console.warn(
          "[MemoryRecall] Search path failed:",
          s.reason?.message || s.reason,
        );
      }
    }

    // Score + de-duplicate (keep the best version of each block).
    const bestById = new Map();
    for (const b of results) {
      const scored = {
        ...b,
        _score: this.scoreBlock(b, normalizedQuery, keywords),
      };
      const existing = bestById.get(scored.id);
      if (!existing || (scored._score ?? 0) > (existing._score ?? 0)) {
        bestById.set(scored.id, scored);
      }
    }

    const sorted = [...bestById.values()].sort(
      (a, b) => (b._score ?? 0) - (a._score ?? 0),
    );

    if (!twoStageEnabled) return sorted;

    // Stage 2: re-rank already happened via `_score`; now apply a diversity cap.
    const perDocCounts = new Map();
    const final = [];

    for (const b of sorted) {
      const docId = b.root_id || b.id;
      const c = perDocCounts.get(docId) || 0;
      if (c >= perDocBlockCap) continue;
      perDocCounts.set(docId, c + 1);
      final.push(b);
      if (final.length >= finalBlockLimit) break;
    }

    return final;
  }

  isCJKKeyword(w) {
    return typeof w === "string" && /^[\u4e00-\u9fa5]{2,}$/.test(w.trim());
  }

  minKeywordMatchesForQuery(keywords) {
    const ks = (Array.isArray(keywords) ? keywords : [])
      .map((k) => (typeof k === "string" ? k.trim() : ""))
      .filter((k) => k.length > 1);

    // Heuristic: for short CJK keyword sets, users usually expect intersection semantics.
    // Example: "张三 简历" should not return docs that only match "简历".
    const cjk = ks.filter((k) => this.isCJKKeyword(k));
    if (cjk.length >= 2 && ks.length <= 4) return 2;
    return 1;
  }

  getKeywordCoverage(doc, keywords) {
    const ks = Array.isArray(keywords) ? keywords : [];
    const matched = new Set();
    const pathLower = String(doc?.path || "").toLowerCase();
    const blocks = Array.isArray(doc?.blocks) ? doc.blocks : [];

    for (const k0 of ks) {
      const k = String(k0 || "").trim();
      if (!k) continue;
      const kLower = k.toLowerCase();

      if (pathLower.includes(kLower)) {
        matched.add(k);
        continue;
      }

      for (const b of blocks) {
        const c = String(b?.content || "").toLowerCase();
        if (c.includes(kLower)) {
          matched.add(k);
          break;
        }
      }
    }

    return { matchedCount: matched.size, matchedKeywords: [...matched] };
  }

  getTopicKeywords() {
    const fromConfig = this.config.recall?.topicKeywords;
    return Array.isArray(fromConfig)
      ? fromConfig.map((s) => String(s || "").trim()).filter(Boolean)
      : [];
  }

  getQueryTopicHits(keywords) {
    const topics = new Set(this.getTopicKeywords());
    if (topics.size === 0) return [];
    const ks = Array.isArray(keywords) ? keywords : [];
    const hits = [];
    for (const k0 of ks) {
      const k = String(k0 || "").trim();
      if (k && topics.has(k)) hits.push(k);
    }
    return hits;
  }

  getAnchorKeywords(keywords) {
    const topicHits = new Set(this.getQueryTopicHits(keywords));
    const ks = (Array.isArray(keywords) ? keywords : [])
      .map((k) => String(k || "").trim())
      .filter((k) => k.length > 1 && !topicHits.has(k));

    // Prefer longer entity-like tokens first. Keep only a small set of anchors.
    // For CJK queries, a 2-3 char name often matters; for English, longer tokens win.
    const sorted = [...new Set(ks)].sort((a, b) => b.length - a.length);
    return sorted.slice(0, 2);
  }

  docMetaMatchesAnyTopic(doc, topicHits) {
    const topics = Array.isArray(topicHits) ? topicHits : [];
    if (topics.length === 0) return false;

    const path = String(doc?.path || "");
    for (const t of topics) {
      if (t && path.includes(t)) return true;
    }

    // Also consider headings: first line of each block that looks like a Markdown heading.
    const blocks = Array.isArray(doc?.blocks) ? doc.blocks : [];
    for (const b of blocks) {
      const content = typeof b?.content === "string" ? b.content : "";
      const first = (content.split(/\r?\n/)[0] || "").trim();
      if (!/^#{1,6}\s+/.test(first)) continue;
      for (const t of topics) {
        if (t && first.includes(t)) return true;
      }
    }

    return false;
  }

  /**
   * Search using full-text search
   * @param {string} query - Search query
   * @returns {Promise<Array>} Search results
   */
  async searchFullText(query, options = {}) {
    if (
      options &&
      typeof options === "object" &&
      Object.keys(options).length > 0
    ) {
      return await this.client.searchFullText(query, options);
    }
    return await this.client.searchFullText(query);
  }

  /**
   * Search using local FTS index
   * @param {string} query - Search query
   * @returns {Promise<Array>} Search results
   */
  async searchLocalFTS(query, options = {}) {
    if (!this.indexManager) {
      return [];
    }

    const limit = options.limit || 20;
    const keywords = Array.isArray(options.keywords) ? options.keywords : null;
    const ftsQuery = this.buildFtsCandidateQuery(query, keywords);
    const results = this.indexManager.search(ftsQuery, { limit });

    // Convert to common format
    return results.map((row) => ({
      id: row.block_id,
      content: row.content,
      hpath: row.hpath,
      root_id: row.doc_id,
      updated: row.updated_at,
      rank: row.rank,
    }));
  }

  buildFtsCandidateQuery(query, keywords) {
    const q = this.normalizeQuery(query);
    if (!keywords || keywords.length < 2) return q;

    const isCJK = (w) => this.isCJKKeyword(w);
    const ks = this.clampKeywordCount(keywords)
      .map((k) => String(k || "").trim())
      .filter(Boolean);
    const cjk = ks.filter(isCJK);

    // For short CJK queries, default to intersection semantics using phrase terms.
    // This reduces noise from docs that match only one of the keywords.
    if (cjk.length >= 2 && ks.length <= 4) {
      return cjk
        .slice(0, 4)
        .map((k) => `\"${k}\"`)
        .join(" ");
    }

    // If the user query is long/natural-language, FTS "AND" matching can be too strict.
    // Build an "OR" query to increase recall in stage 1.
    if (q.length >= 18) {
      if (ks.length >= 2) return ks.join(" OR ");
    }
    return q;
  }

  /**
   * Search using SQL query
   * @param {string} query - Search query
   * @param {object} timeRange - Time range filter
   * @param {object} options
   * @returns {Promise<Array>} Search results
   */
  async searchSQL(query, timeRange, options = {}) {
    const extracted = this.extractKeywords(query);
    const keywords = Array.isArray(options.keywords)
      ? options.keywords
      : extracted;
    const escapeLike = (s) =>
      String(s)
        .replace(/\\/g, "\\\\")
        .replace(/%/g, "\\%")
        .replace(/_/g, "\\_")
        .replace(/'/g, "''");

    const limited = this.clampKeywordCount(keywords);
    // SQLite requires ESCAPE to be a single character; use backslash.
    const likeTerms = limited.map(
      (k) => `content LIKE '%${escapeLike(k)}%' ESCAPE '\\'`,
    );
    // Fallback to querying the raw query if keyword extraction yields nothing useful.
    if (likeTerms.length === 0 && query) {
      likeTerms.push(`content LIKE '%${escapeLike(query)}%' ESCAPE '\\'`);
    }

    let whereClause = likeTerms.length ? `(${likeTerms.join(" OR ")})` : "1=0";

    if (timeRange?.since) {
      // Ensure correct precedence: (a OR b) AND updated > ...
      whereClause += ` AND updated > '${escapeLike(timeRange.since)}'`;
    }

    const stmt = `
      SELECT * FROM blocks
      WHERE (${whereClause})
        AND type != 'd'
        AND content IS NOT NULL
        AND TRIM(content) != ''
      ORDER BY updated DESC
      LIMIT ${Number.isFinite(Number(options.limit)) ? Number(options.limit) : 20}
    `;

    return await this.client.query(stmt);
  }

  normalizeBlock(block, source) {
    const b = block && typeof block === "object" ? block : {};
    const id = b.id || b.block_id || b.blockID || b.blockId;
    const root_id = b.root_id || b.rootID || b.doc_id || b.docID || b.rootId;
    const hpath = b.hpath || b.path || b.hPath;
    const updated =
      b.updated ||
      b.updated_at ||
      b.updatedAt ||
      b.modified ||
      b.modified_at ||
      b.created_at;

    return {
      ...b,
      id,
      root_id,
      hpath,
      updated,
      _source: source,
    };
  }

  scoreBlock(block, query, keywords) {
    const contentRaw = typeof block?.content === "string" ? block.content : "";
    const content = contentRaw.replace(/<[^>]+>/g, " ").toLowerCase();
    const path = (block?.hpath || "").toLowerCase();
    const q = (query || "").toLowerCase();

    // Base score per source (local FTS tends to be higher-precision, SQL the noisiest).
    const sourceWeight =
      block?._source === "fts"
        ? 1.0
        : block?._source === "fulltext"
          ? 0.9
          : 0.75;

    let score = 0;
    if (q && q.length >= 3) {
      if (content.includes(q)) score += 1.2;
      if (path.includes(q)) score += 0.6;
    }

    const ks = Array.isArray(keywords) ? keywords : [];
    for (const k0 of ks) {
      const k = String(k0 || "").toLowerCase();
      if (!k) continue;
      if (content.includes(k)) score += 0.35;
      if (path.includes(k)) score += 0.15;
    }

    // Light recency boost (helps "最近/上周" style queries, but won't dominate relevance).
    const updated = typeof block?.updated === "string" ? block.updated : "";
    if (updated) {
      const days = this.daysSince(updated);
      if (typeof days === "number" && days >= 0) {
        score += Math.max(0, 0.3 - days * 0.01);
      }
    }

    // If local FTS provides an FTS rank, incorporate it (smaller is better for bm25/rank-style).
    const r = Number(block?.rank);
    if (Number.isFinite(r)) {
      score += Math.max(0, 0.8 - Math.min(0.8, r));
    }

    return score * sourceWeight;
  }

  daysSince(dateLike) {
    // Accept ISO date or datetime; invalid values return null.
    const d = new Date(dateLike);
    if (Number.isNaN(d.getTime())) return null;
    const now = new Date();
    return Math.floor((now.getTime() - d.getTime()) / (24 * 3600 * 1000));
  }

  /**
   * Group blocks by document
   * @param {Array} blocks - Block results
   * @returns {object} Grouped by document id
   */
  groupByDocument(blocks) {
    const grouped = {};

    const fingerprintOf = (block) => {
      // FTS may return both doc-level entries and section-level entries with identical content.
      // De-dup by a normalized prefix to avoid repeated bullets in the final context.
      const raw = typeof block?.content === "string" ? block.content : "";
      const normalized = raw.replace(/\s+/g, " ").trim();
      return normalized.slice(0, 800);
    };

    for (const block of blocks) {
      const docId = block.root_id || block.id;

      if (!grouped[docId]) {
        grouped[docId] = {
          docId,
          path: block.hpath,
          blocks: [],
          _bestByFp: new Map(),
        };
      }

      const fp = fingerprintOf(block);
      const existing = grouped[docId]._bestByFp.get(fp);
      const score = typeof block?._score === "number" ? block._score : 0;
      const existingScore =
        typeof existing?._score === "number" ? existing._score : 0;
      if (!existing || score > existingScore) {
        grouped[docId]._bestByFp.set(fp, block);
      }
    }

    // Materialize de-duped blocks.
    for (const docId of Object.keys(grouped)) {
      const doc = grouped[docId];
      doc.blocks = [...doc._bestByFp.values()];
      delete doc._bestByFp;
    }

    return grouped;
  }

  /**
   * Aggregate and rank results by relevance
   * @param {Array} blocks - Block results
   * @param {string[]} keywords - Query keywords
   * @returns {Array} Ranked documents
   */
  aggregateResults(blocks, keywords) {
    // Group by document
    const grouped = this.groupByDocument(blocks);

    // Calculate relevance scores
    const minMatch = this.minKeywordMatchesForQuery(keywords);
    const docs = Object.values(grouped).map((doc) => {
      const coverage = this.getKeywordCoverage(doc, keywords);
      const baseScore = this.calculateRelevanceScore(doc, keywords);
      const coverageFactor =
        minMatch > 1 ? Math.min(1, coverage.matchedCount / minMatch) : 1;

      return {
        ...doc,
        updated: this.getDocUpdated(doc),
        score: baseScore * coverageFactor,
        keywordCoverage: coverage,
        recentlyEdited: this.isRecentlyEdited(doc),
      };
    });

    // Sort by score
    docs.sort((a, b) => b.score - a.score);

    // Filter obvious false positives for short CJK queries: require at least N distinct keyword hits
    // across the document (path + blocks). Fall back to the unfiltered list if we'd otherwise return nothing.
    const filtered = docs.filter(
      (d) => (d.keywordCoverage?.matchedCount ?? 0) >= minMatch,
    );
    let candidates = filtered.length > 0 ? filtered : docs;

    // Generic narrowing:
    // 1) If the query contains any configured "topic" keywords (e.g. 简历/周报/会议纪要),
    //    prefer documents whose meta (path or headings) mention those topics.
    const topicHits = this.getQueryTopicHits(keywords);
    if (topicHits.length > 0) {
      const metaMatches = candidates.filter((d) =>
        this.docMetaMatchesAnyTopic(d, topicHits),
      );
      if (metaMatches.length > 0) {
        candidates = metaMatches;
      }
    }

    // 2) If we can identify anchor keywords (typically entities like names), require at least
    //    one anchor match when that would reduce noise without yielding an empty set.
    const anchors = this.getAnchorKeywords(keywords);
    if (anchors.length > 0) {
      const anchorSet = new Set(anchors);
      const anchorMatches = candidates.filter((d) =>
        (d.keywordCoverage?.matchedKeywords || []).some((k) =>
          anchorSet.has(k),
        ),
      );
      if (anchorMatches.length > 0) {
        candidates = anchorMatches;
      }
    }

    return candidates;
  }

  getDocUpdated(doc) {
    const latest = (doc?.blocks || []).reduce((best, b) => {
      const u = b?.updated;
      if (!u) return best;
      if (!best) return u;
      // ISO strings compare lexicographically; fallback to Date if needed.
      if (typeof u === "string" && typeof best === "string") {
        return u > best ? u : best;
      }
      const du = new Date(u);
      const db = new Date(best);
      if (Number.isNaN(du.getTime())) return best;
      if (Number.isNaN(db.getTime())) return u;
      return du > db ? u : best;
    }, null);
    return latest || doc?.updated || null;
  }

  /**
   * Calculate document relevance score
   * @param {object} doc - Document info
   * @param {string[]} keywords - Query keywords
   * @returns {number} Relevance score (0-1)
   */
  calculateRelevanceScore(doc, keywords) {
    if (!keywords || keywords.length === 0) {
      return 0.5;
    }

    // Use top-N block scores if available; otherwise fallback to keyword hit-rate.
    const blocks = Array.isArray(doc?.blocks) ? doc.blocks : [];
    const scored = blocks
      .map((b) => (typeof b?._score === "number" ? b._score : null))
      .filter((n) => typeof n === "number")
      .sort((a, b) => b - a);

    let score = 0;
    if (scored.length > 0) {
      const top = scored.slice(0, 5);
      const avg = top.reduce((s, x) => s + x, 0) / top.length;
      // Map an unbounded score to 0..1 smoothly.
      score = 1 - Math.exp(-avg);
    } else {
      const totalBlocks = Math.max(1, blocks.length);
      for (const keyword of keywords) {
        const kw = String(keyword || "").toLowerCase();
        if (!kw) continue;
        const matchingBlocks = blocks.filter((b) =>
          String(b?.content || "")
            .toLowerCase()
            .includes(kw),
        );
        score += matchingBlocks.length / totalBlocks;
      }
      score = Math.min(score / keywords.length, 1);
    }

    // Boost if path contains keywords
    const pathLower = doc.path?.toLowerCase() || "";
    const pathMatches = keywords.filter((k) => pathLower.includes(k)).length;
    score += pathMatches * 0.1;

    return Math.min(score, 1);
  }

  /**
   * Check if document was recently edited
   * @param {object} doc - Document info
   * @returns {boolean} True if recently edited
   */
  isRecentlyEdited(doc) {
    // Consider documents edited in last 7 days as recent
    const sevenDaysAgo = this.getDaysAgo(7);

    const latestBlock = doc.blocks.reduce((latest, block) => {
      if (!latest || block.updated > latest.updated) {
        return block;
      }
      return latest;
    }, null);

    return latestBlock && latestBlock.updated >= sevenDaysAgo;
  }

  /**
   * Format recalled documents as context string
   * @param {Array} docs - Ranked documents
   * @returns {string} Formatted context
   */
  formatContext(docs) {
    if (docs.length === 0) {
      console.log("[siyuan] No documents found");
      return "";
    }

    const maxTokens = this.config.recall?.maxContextTokens || 2000;
    const avgCharsPerToken = 4; // Rough estimate
    const maxChars = maxTokens * avgCharsPerToken;

    let context = "<siyuan_context>\n以下是用户思源笔记中的相关内容：\n\n";
    let currentLength = context.length;

    for (const doc of docs) {
      const remaining = maxChars - currentLength;
      if (remaining <= 0) break;
      const docSection = this.formatDocument(doc, { maxChars: remaining });

      if (!docSection) break;
      if (currentLength + docSection.length > maxChars) {
        break;
      }

      context += docSection + "\n";
      currentLength += docSection.length;
    }

    context += "</siyuan_context>";

    return context;
  }

  /**
   * Format single document
   * @param {object} doc - Document info
   * @param {object} opts
   * @param {number} opts.maxChars - Max chars allowed for this section
   * @returns {string} Formatted document section
   */
  formatDocument(doc, opts = {}) {
    const maxChars =
      Number.isFinite(Number(opts.maxChars)) && Number(opts.maxChars) > 0
        ? Number(opts.maxChars)
        : Infinity;

    const date = doc.updated || this.getDocUpdated(doc) || "未知日期";
    const path = doc.path || `[doc:${doc.docId || doc.id || "unknown"}]`;

    // Linked-doc mode: include full markdown (truncated to fit overall context budget).
    const mdRaw = typeof doc.markdown === "string" ? doc.markdown : "";
    if (mdRaw.trim()) {
      const header = `## 🔗 ${path} (${date})\n`;
      const pre = `${header}\`\`\`markdown\n`;
      const post = `\n\`\`\`\n`;
      const room = maxChars - (pre.length + post.length);
      if (room <= 60) return ""; // not enough room to be useful
      let md = mdRaw.trim();
      if (md.length > room) {
        md = md.slice(0, Math.max(0, room - 3)).trimEnd() + "...";
      }
      return pre + md + post;
    }

    let section = `## 📄 ${path} (${date})\n`;

    // Take top blocks (limit to avoid too much content)
    const topBlocks = (doc.blocks || [])
      .slice()
      .sort((a, b) => (b?._score ?? 0) - (a?._score ?? 0))
      .slice(0, 5);

    const excerptMaxCharsRaw = this.config?.recall?.blockExcerptMaxChars;
    const excerptMaxChars =
      Number.isFinite(Number(excerptMaxCharsRaw)) &&
      Number(excerptMaxCharsRaw) > 0
        ? Number(excerptMaxCharsRaw)
        : 540;

    for (const block of topBlocks) {
      const content = (
        typeof block.content === "string" ? block.content : ""
      ).trim();
      if (content.length > 0) {
        const lines = content
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        const first = lines[0] || "";
        const headingMatch = first.match(/^(#{1,6})\s+(.*)$/);
        const title = headingMatch ? headingMatch[2] : first;
        const rest = lines.slice(1).join(" ");
        const excerpt =
          rest.length > excerptMaxChars
            ? rest.slice(0, excerptMaxChars) + "..."
            : rest;

        section += `- ${title}\n`;
        if (excerpt) section += `  ${excerpt}\n`;
      }
    }

    return section;
  }
}
