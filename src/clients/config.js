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
  },
  recall: {
    enabled: true,
    minPromptLength: 10,
    maxContextTokens: 2000,
    searchPaths: ["fulltext", "sql", "fts"],
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
