import crypto from "crypto";

/**
 * Content write system for persisting conversations to SiYuan
 */
export class ContentWriter {
  /**
   * @param {object} siyuanClient - SiYuan API client
   * @param {object} config - Plugin configuration
   */
  constructor(siyuanClient, config) {
    this.client = siyuanClient;
    this.config = config;
    this.writeHistory = new Set(); // Track written content hashes
    this._notebooksCache = null;
  }

  /**
   * Normalize various LLM SDK message content shapes to plain text.
   * Some providers return `content` as an array of blocks (e.g. [{type:'text', text:'...'}]).
   * @param {any} value
   * @returns {string}
   */
  normalizeMessageContent(value) {
    if (typeof value === "string") return value;
    if (value == null) return "";
    if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "bigint"
    )
      return String(value);

    // Common: array of content blocks (OpenAI/Anthropic-style)
    if (Array.isArray(value)) {
      return value
        .map((part) => {
          if (typeof part === "string") return part;
          if (part == null) return "";
          if (typeof part === "object") {
            // Anthropic: {type:'text', text:'...'}
            if (part.type === "text" && typeof part.text === "string")
              return part.text;
            // Some SDKs: {type:'text', text:{value:'...'}}
            if (
              part.type === "text" &&
              part.text &&
              typeof part.text.value === "string"
            )
              return part.text.value;
            // OpenAI: {type:'output_text'|'input_text', text:'...'}
            if (
              (part.type === "output_text" || part.type === "input_text") &&
              typeof part.text === "string"
            )
              return part.text;
            // Generic fallback keys
            if (typeof part.text === "string") return part.text;
            if (part.text && typeof part.text.value === "string")
              return part.text.value;
            if (typeof part.content === "string") return part.content;
          }
          return "";
        })
        .join("");
    }

    if (typeof value === "object") {
      if (typeof value.text === "string") return value.text;
      if (value.text && typeof value.text.value === "string")
        return value.text.value;
      if (typeof value.content === "string") return value.content;
      if (value.type === "text" && typeof value.text === "string")
        return value.text;
      if (
        value.type === "text" &&
        value.text &&
        typeof value.text.value === "string"
      )
        return value.text.value;

      // Last resort: avoid crashing; don't spam notes with [object Object]
      try {
        const json = JSON.stringify(value);
        return json === "{}" ? "" : json;
      } catch {
        return "";
      }
    }

    return "";
  }

  /**
   * Extract relevant content from message history
   * @param {Array} messages - Message history
   * @param {string} strategy - Capture strategy (last_turn, full_session, smart)
   * @returns {object} Extracted content
   */
  extractContent(messages, strategy = "smart") {
    if (!messages || messages.length === 0) {
      return {
        userMessage: "",
        assistantMessage: "",
        fullConversation: [],
      };
    }

    if (strategy === "full_session") {
      const normalizedMessages = messages.map((m) => ({
        ...m,
        content: this.normalizeMessageContent(m?.content),
      }));
      return {
        fullConversation: normalizedMessages,
        userMessage: normalizedMessages
          .filter((m) => m.role === "user")
          .map((m) => m.content)
          .join("\n"),
        assistantMessage: normalizedMessages
          .filter((m) => m.role === "assistant")
          .map((m) => m.content)
          .join("\n"),
      };
    }

    if (strategy === "smart") {
      // Filter out short/greeting messages and get substantive content
      const substantiveMessages = messages.filter((m) => {
        const content = this.normalizeMessageContent(m?.content).trim();
        return content.length >= 10 && !this.isGreeting(content);
      });

      if (substantiveMessages.length === 0) {
        return { userMessage: "", assistantMessage: "" };
      }

      // Get last substantive exchange
      const lastUser = [...substantiveMessages]
        .reverse()
        .find((m) => m.role === "user");
      const lastAssistant = [...substantiveMessages]
        .reverse()
        .find((m) => m.role === "assistant");

      return {
        userMessage: this.normalizeMessageContent(lastUser?.content),
        assistantMessage: this.normalizeMessageContent(lastAssistant?.content),
      };
    }

    // Default: last_turn
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant");

    return {
      userMessage: this.normalizeMessageContent(lastUser?.content),
      assistantMessage: this.normalizeMessageContent(lastAssistant?.content),
    };
  }

  /**
   * Check if message is a greeting
   * @param {string} content - Message content
   * @returns {boolean} True if greeting
   */
  isGreeting(content) {
    const greetings = [
      "你好",
      "hello",
      "hi",
      "嗨",
      "好",
      "谢谢",
      "thanks",
      "thank you",
      "bye",
      "再见",
      "ok",
      "okay",
      "好的",
      "嗯",
      "哦",
    ];

    const lower = content.toLowerCase().trim();
    return greetings.some(
      (g) => lower === g || lower === g + "！" || lower === g + "!",
    );
  }

  /**
   * Determine if content should be written
   * @param {object} content - Extracted content
   * @returns {boolean} True if should write
   */
  shouldWrite(content) {
    const minLength = this.config.write?.minContentLength || 50;

    // Accept if contains code blocks (regardless of length)
    if (content.assistantMessage?.includes("```")) {
      return true;
    }

    // Filter greetings
    if (
      this.isGreeting(content.userMessage) ||
      this.isGreeting(content.assistantMessage)
    ) {
      return false;
    }

    // Check minimum length
    const totalLength =
      (content.userMessage?.length || 0) +
      (content.assistantMessage?.length || 0);

    if (totalLength < minLength) {
      return false;
    }

    return true;
  }

  /**
   * Format content based on target and template
   * @param {object} content - Extracted content
   * @param {object} routing - Routing decision
   * @returns {string} Formatted markdown
   */
  formatContent(content, routing) {
    const now = new Date();
    const time = now.toTimeString().split(" ")[0].substring(0, 5); // HH:MM
    const date = now.toISOString().split("T")[0];

    if (routing.target === "daily_note") {
      return this.formatDailyNote(content, time);
    }

    if (routing.target === this.config.routing?.inboxPath) {
      return this.formatInbox(content, date, time);
    }

    return this.formatAppend(content, date, time);
  }

  /**
   * Format as daily note entry
   * @param {object} content - Content
   * @param {string} time - Time string
   * @returns {string} Formatted markdown
   */
  formatDailyNote(content, time) {
    const title = this.generateTitle(content.userMessage);

    return `
### ${time} ${title}

**问**: ${content.userMessage}

**答**: ${content.assistantMessage}

#openclaw
`.trim();
  }

  /**
   * Format as append entry
   * @param {object} content - Content
   * @param {string} date - Date string
   * @param {string} time - Time string
   * @returns {string} Formatted markdown
   */
  formatAppend(content, date, time) {
    return `
---
*${date} ${time} via OpenClaw*

${content.userMessage}

${content.assistantMessage}
`.trim();
  }

  /**
   * Format as inbox entry
   * @param {object} content - Content
   * @param {string} date - Date string
   * @param {string} time - Time string
   * @returns {string} Formatted markdown
   */
  formatInbox(content, date, time) {
    const title = this.generateTitle(content.userMessage);

    return `
### 📥 ${title}
*时间: ${date} ${time} | 来源: OpenClaw*

**问题**: ${content.userMessage}

**回答**: ${content.assistantMessage}

#待整理
`.trim();
  }

  /**
   * Generate title from user message
   * @param {string} message - User message
   * @returns {string} Generated title
   */
  generateTitle(message) {
    // Take first sentence or first 30 characters
    const firstSentence = message.split(/[。！？.!?]/)[0];
    const title =
      firstSentence.length > 30
        ? firstSentence.substring(0, 30) + "..."
        : firstSentence;

    return title.trim();
  }

  /**
   * Write content to SiYuan
   * @param {object} content - Extracted content
   * @param {object} routing - Routing decision
   * @param {object} metadata - Additional metadata
   * @returns {Promise<object>} Write result
   */
  async write(content, routing, metadata = {}) {
    // Check for duplicates
    const hash = this.generateContentHash(content);
    if (this.writeHistory.has(hash)) {
      return { skipped: true, reason: "duplicate" };
    }

    // Format content
    const formatted = this.formatContent(content, routing);

    // Resolve target path
    const targetPath = await this.resolveTargetPath(routing.target);

    // Get or create document
    let doc = await this.client.getDocByPath(targetPath);
    console.log("[Openclaw Siyuan] target path ", targetPath);

    if (!doc) {
      // Create new document
      const notebook = await this.guessNotebook(targetPath);
      doc = await this.client.createDocWithMd({
        notebook: notebook.id,
        path: targetPath,
        markdown: "",
      });
    }

    // Write based on mode
    let blockId;

    if (routing.writeMode === "append" || !routing.writeMode) {
      const result = await this.client.appendBlock({
        parentID: doc.id,
        data: formatted,
        dataType: "markdown",
      });
      blockId = typeof result === "string" ? result : result?.id;
    } else if (routing.writeMode === "update") {
      await this.client.updateBlock({
        id: doc.id,
        data: formatted,
        dataType: "markdown",
      });
      blockId = doc.id;
    } else if (routing.writeMode === "child_doc") {
      const childDoc = await this.client.createDocWithMd({
        notebook: doc.notebook,
        path: `${targetPath}/${this.generateTitle(content.userMessage)}`,
        markdown: formatted,
      });
      blockId = typeof childDoc === "string" ? childDoc : childDoc?.id;
    }

    // Set block attributes
    if (blockId) {
      await this.client.setBlockAttrs(blockId, {
        "custom-source": "openclaw",
        "custom-channel": metadata.channel || "unknown",
        "custom-session": metadata.sessionId || "",
        "custom-timestamp": new Date().toISOString(),
      });
    }

    // Record in history
    this.writeHistory.add(hash);

    return {
      success: true,
      docId: doc.id,
      blockId,
      path: targetPath,
    };
  }

  /**
   * Resolve target path (handle special values like daily_note)
   * @param {string} target - Target from routing
   * @returns {Promise<string>} Resolved path
   */
  async resolveTargetPath(target) {
    if (target === "daily_note") {
      const today = new Date().toISOString().split("T")[0];
      return `/daily/${today}`;
    }

    return target;
  }

  /**
   * Guess notebook from path
   * @param {string} _path - Document path
   * @returns {Promise<object>} Notebook info
   */
  async guessNotebook(_path) {
    const path = typeof _path === "string" ? _path : "";

    // Allow explicit override (useful when notebook listing is unavailable).
    const configuredId =
      this.config?.write?.defaultNotebookId ||
      this.config?.routing?.defaultNotebookId ||
      this.config?.siyuan?.defaultNotebookId;
    if (configuredId) {
      return {
        id: configuredId,
        name:
          this.config?.write?.defaultNotebookName ||
          this.config?.routing?.defaultNotebookName ||
          this.config?.siyuan?.defaultNotebookName ||
          "",
      };
    }

    // If the client doesn't support listing notebooks, keep legacy behavior.
    if (!this.client || typeof this.client.listNotebooks !== "function") {
      return { id: "default-notebook", name: "Default" };
    }

    if (!this._notebooksCache) {
      const notebooks = await this.client.listNotebooks();
      this._notebooksCache = Array.isArray(notebooks) ? notebooks : [];
    }

    const notebooks = this._notebooksCache;
    if (notebooks.length === 0) {
      throw new Error("No notebooks available from SiYuan");
    }

    const normalize = (s) => String(s || "").trim().toLowerCase();
    const findByName = (name) =>
      notebooks.find((nb) => normalize(nb?.name) === normalize(name));

    const candidates = [];
    const top = this.extractTopPathSegment(path);
    if (top) candidates.push(top);

    // Common case: path is routed under inboxPath's top folder.
    const inboxTop = this.extractTopPathSegment(this.config?.routing?.inboxPath);
    if (inboxTop && inboxTop !== top) candidates.push(inboxTop);

    const configuredName =
      this.config?.write?.defaultNotebookName ||
      this.config?.routing?.defaultNotebookName ||
      this.config?.siyuan?.defaultNotebookName;
    if (configuredName) candidates.push(configuredName);

    for (const name of candidates) {
      const nb = findByName(name);
      if (nb) return nb;
    }

    // Fall back to the first notebook (SiYuan typically returns in a stable order).
    return notebooks[0];
  }

  extractTopPathSegment(value) {
    const s = typeof value === "string" ? value.trim() : "";
    if (!s) return "";
    const parts = s.split("/").filter(Boolean);
    return parts[0] || "";
  }

  /**
   * Generate hash for content deduplication
   * @param {object} content - Content to hash
   * @returns {string} Content hash
   */
  generateContentHash(content) {
    const text = `${content.userMessage}::${content.assistantMessage}`;
    return crypto.createHash("sha256").update(text).digest("hex");
  }
}
