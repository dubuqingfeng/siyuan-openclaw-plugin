import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * Default configuration for OpenClaw SiYuan plugin
 */
const DEFAULT_CONFIG = {
  siyuan: {
    apiUrl: "http://127.0.0.1:6806",
    apiToken: "",
  },
  routing: {
    rules: [],
    inboxPath: "/OpenClaw/收件箱",
    archivePath: "/OpenClaw/对话归档",
  },
  index: {
    enabled: true,
    syncIntervalMs: 5 * 60 * 1000, // 5 minutes
    dbPath: join(homedir(), ".openclaw", "index.sqlite"),
    // Optional: exclude sensitive/archived notebooks from local indexing.
    privacyNotebook: "",
    archiveNotebook: "",
    skipNotebookNames: [],

    // Optional: split documents into sections by heading levels for better retrieval relevance.
    // Examples: [2] (H2), [1,2] (H1+H2), ["h3"] (H3), [] (disable section splitting).
    sectionHeadingLevels: [2],
    maxSectionsToIndex: 80,
    sectionMaxChars: 1200,
    // Best-effort de-duplicate consecutive identical lines when building section content.
    sectionDedupLines: true,
    // Window size for de-dup (applies when sectionDedupLines=true). Helps remove repeated list groups.
    sectionDedupWindowSize: 200,
    // Also apply line de-dup to doc.content (the doc-level FTS entry).
    docContentDedupLines: true,
    docContentDedupWindowSize: 400,
  },
  recall: {
    enabled: true,
    minPromptLength: 10,
    maxContextTokens: 2000,
    // Optional: cap number of recalled documents injected into context.
    // (Blocks per doc are still controlled by perDocBlockCap/finalBlockLimit in twoStage.)
    maxDocs: 5,
    // Optional: "topic" keywords used to narrow candidates by doc meta (path/headings).
    // Keep this small; treat as user-configurable vocabulary.
    topicKeywords: ["简历", "周报", "日报", "会议纪要", "复盘", "总结"],
    searchPaths: ["fulltext", "sql", "fts"],
  },
  // If the prompt contains a SiYuan share/app link (domain/IP + ?id=...), fetch that doc's markdown
  // and inject it into context. This is intentionally separate from `recall.enabled`.
  linkedDoc: {
    enabled: true,
    // Optional host/domain/IP keywords to restrict which links are considered (substring match).
    // Example: ["127.0.0.1", "notes.example.com"]
    hostKeywords: [],
    // Safety cap: maximum number of linked docs to fetch per prompt.
    maxCount: 3,
  },
  write: {
    enabled: true,
    captureStrategy: "smart", // 'last_turn', 'full_session', 'smart'
    throttleMs: 3000,
    minContentLength: 50,
  },
};

/**
 * Deep merge two objects
 * @param {object} target - Target object
 * @param {object} source - Source object
 * @returns {object} Merged object
 */
function deepMerge(target, source) {
  const result = { ...target };

  for (const key in source) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key])
    ) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }

  return result;
}

function resolveConfigPath(configPath) {
  // If caller explicitly provided a path, don't guess.
  if (configPath) return configPath;

  const cwd = process.cwd();
  const candidates = [
    // User home config (primary default).
    join(homedir(), ".openclaw", "siyuan.config.json"),

    // Prefer explicit project-local config when present (useful for dev/tests).
    join(cwd, "openclaw.config.json"),
    join(cwd, "openclaw.json"),

    // Backwards-compatible fallback.
    join(homedir(), ".openclaw", "openclaw.json"),
  ];

  // Default to the primary home config location even if it doesn't exist yet.
  return candidates.find((p) => existsSync(p)) || candidates[0];
}

/**
 * Build configuration from file and environment
 * @param {string} configPath - Path to configuration file
 * @returns {object} Complete configuration object
 */
export function buildConfig(configPath) {
  let userConfig = {};

  // Try to load from file
  configPath = resolveConfigPath(configPath);
  console.log("[Openclaw Siyuan] config path is", configPath);

  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, "utf-8");
      userConfig = JSON.parse(content);
    } catch (error) {
      console.warn(`Failed to load config from ${configPath}:`, error.message);
    }
  }

  // Override with environment variables
  const envConfig = {};
  if (process.env.SIYUAN_API_URL) {
    envConfig.siyuan = envConfig.siyuan || {};
    envConfig.siyuan.apiUrl = process.env.SIYUAN_API_URL;
  }
  if (process.env.SIYUAN_API_TOKEN) {
    envConfig.siyuan = envConfig.siyuan || {};
    envConfig.siyuan.apiToken = process.env.SIYUAN_API_TOKEN;
  }

  // Merge configurations: defaults < file < environment
  return deepMerge(deepMerge(DEFAULT_CONFIG, userConfig), envConfig);
}

/**
 * Validate configuration
 * @param {object} config - Configuration to validate
 * @returns {object} Validation result with isValid and errors
 */
export function validateConfig(config) {
  const errors = [];

  if (!config.siyuan || !config.siyuan.apiUrl) {
    errors.push("siyuan.apiUrl is required");
  }

  if (config.siyuan && config.siyuan.apiUrl) {
    try {
      new URL(config.siyuan.apiUrl);
    } catch {
      errors.push("siyuan.apiUrl must be a valid URL");
    }
  }

  if (config.recall && typeof config.recall.maxContextTokens !== "number") {
    errors.push("recall.maxContextTokens must be a number");
  }
  if (
    config.recall &&
    config.recall.maxDocs != null &&
    typeof config.recall.maxDocs !== "number"
  ) {
    errors.push("recall.maxDocs must be a number or null");
  }
  if (config.recall && config.recall.topicKeywords != null) {
    if (!Array.isArray(config.recall.topicKeywords)) {
      errors.push("recall.topicKeywords must be an array");
    } else if (
      config.recall.topicKeywords.some(
        (x) => typeof x !== "string" || !String(x).trim(),
      )
    ) {
      errors.push("recall.topicKeywords must contain non-empty strings");
    }
  }
  // linkedDoc can be configured at top-level (preferred) or under recall (legacy).
  const linkedDocCfg = config?.linkedDoc ?? config?.recall?.linkedDoc;
  if (linkedDocCfg != null) {
    const ld = linkedDocCfg;
    if (typeof ld !== "object" || Array.isArray(ld)) {
      errors.push("linkedDoc must be an object");
    } else {
      if (ld.hostKeywords != null && !Array.isArray(ld.hostKeywords)) {
        errors.push("linkedDoc.hostKeywords must be an array");
      } else if (
        Array.isArray(ld.hostKeywords) &&
        ld.hostKeywords.some((x) => typeof x !== "string" || !String(x).trim())
      ) {
        errors.push("linkedDoc.hostKeywords must contain non-empty strings");
      }
      if (ld.maxCount != null && typeof ld.maxCount !== "number") {
        errors.push("linkedDoc.maxCount must be a number");
      }
      if (ld.enabled != null && typeof ld.enabled !== "boolean") {
        errors.push("linkedDoc.enabled must be a boolean");
      }
    }
  }

  if (
    config.write &&
    !["last_turn", "full_session", "smart"].includes(
      config.write.captureStrategy,
    )
  ) {
    errors.push(
      "write.captureStrategy must be one of: last_turn, full_session, smart",
    );
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}
