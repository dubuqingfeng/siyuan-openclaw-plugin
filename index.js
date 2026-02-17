import { buildConfig } from "./src/clients/config.js";
import { SiYuanClient } from "./src/clients/siyuan-client.js";
import { IndexManager } from "./src/infra/index-manager.js";
import { MemoryRecall } from "./src/services/memory-recall.js";
import { RoutingEngine } from "./src/services/routing-engine.js";
import { ContentWriter } from "./src/services/content-writer.js";
import { IndexSyncService } from "./src/services/index-sync.js";

function deepMerge(target, source) {
  const t = target && typeof target === "object" ? target : {};
  const s = source && typeof source === "object" ? source : {};
  const out = Array.isArray(t) ? [...t] : { ...t };

  for (const key of Object.keys(s)) {
    const sv = s[key];
    const tv = out[key];
    if (
      sv &&
      typeof sv === "object" &&
      !Array.isArray(sv) &&
      tv &&
      typeof tv === "object" &&
      !Array.isArray(tv)
    ) {
      out[key] = deepMerge(tv, sv);
    } else {
      out[key] = sv;
    }
  }

  return out;
}

/**
 * Plugin state
 */
let siyuanClient = null;
let config = null;
let siyuanAvailable = false;
let indexManager = null;
let indexSync = null;
let memoryRecall = null;
let routingEngine = null;
let contentWriter = null;
let initPromise = null;

async function ensureInitialized() {
  if (!initPromise) return;
  try {
    await initPromise;
  } catch (error) {
    // Don't crash event handlers if background init fails.
    console.warn(
      "[OpenClaw SiYuan] Background init failed:",
      error?.message || error,
    );
  }
}

/**
 * Register plugin with OpenClaw Gateway
 * @param {object} api - OpenClaw Gateway API
 * @returns {Promise<object>} Registration result
 */
export function register(api) {
  console.log("[OpenClaw SiYuan] Registering plugin...");

  // Step 1: Build configuration
  // Always start from file/env/default config, then apply gateway overrides (if any).
  // This avoids accidentally dropping `index/recall/write` settings when `api.config.siyuan` is present.
  config = buildConfig();
  if (api?.config && typeof api.config === "object") {
    config = deepMerge(config, api.config);
  }

  console.log("[OpenClaw SiYuan] Configuration loaded");

  // Step 2: Initialize SiYuan client
  try {
    siyuanClient = new SiYuanClient(config.siyuan);
  } catch (error) {
    console.error(
      "[OpenClaw SiYuan] Failed to initialize client:",
      error.message,
    );
    return { siyuanAvailable: false, error: error.message };
  }

  // Step 3: Initialize use case modules (hooks may fire immediately; keep these ready)
  memoryRecall = new MemoryRecall(siyuanClient, config, null);
  routingEngine = new RoutingEngine(config);
  contentWriter = new ContentWriter(siyuanClient, config);

  // Step 4: Register lifecycle hooks
  registerLifecycleHooks(api);

  console.log("[OpenClaw SiYuan] config api url", config.siyuan.apiUrl);

  // Step 5: Background initialization (gateway ignores async registration promises)
  initPromise = (async () => {
    // Initialize local index first (offline recall can still work without SiYuan connectivity).
    if (config.index?.enabled) {
      try {
        indexManager = new IndexManager({
          dbPath: config.index.dbPath,
          privacyNotebook: config.index?.privacyNotebook,
          archiveNotebook: config.index?.archiveNotebook,
          skipNotebookNames: config.index?.skipNotebookNames,
        });
        console.log("[OpenClaw SiYuan] Local index initialized");
      } catch (error) {
        console.error(
          "[OpenClaw SiYuan] Failed to initialize index:",
          error.message,
        );
        indexManager = null;
      }
    }

    // Attach index manager for local FTS searches (optional)
    memoryRecall.indexManager = indexManager;

    // Health check
    const healthResult = await siyuanClient.healthCheck();
    siyuanAvailable = healthResult.available;

    if (siyuanAvailable) {
      console.log(
        `[OpenClaw SiYuan] Connected to SiYuan ${healthResult.version}`,
      );
    } else {
      console.warn(
        "[OpenClaw SiYuan] SiYuan not available, running in degraded mode",
      );
      // Keep local index/recall available even in degraded mode.
      return { siyuanAvailable: false, version: healthResult.version };
    }

    // Start index sync only when both SiYuan and local index are available.
    if (config.index?.enabled && indexManager) {
      indexSync = new IndexSyncService({ siyuanClient, indexManager, config });
      try {
        await indexSync.refreshNotebookCache();
      } catch (error) {
        console.warn(
          "[OpenClaw SiYuan] Failed to refresh notebook cache:",
          error?.message || String(error),
        );
      }

      await indexSync.performInitialSync();
      indexSync.startBackgroundSync();
    }

    return { siyuanAvailable, version: healthResult.version };
  })();

  console.log("[OpenClaw SiYuan] Plugin registered successfully");

  return {
    initializing: true,
    ready: initPromise,
  };
}

/**
 * Register lifecycle hooks with OpenClaw Gateway
 * @param {object} api - OpenClaw Gateway API
 */
function registerLifecycleHooks(api) {
  // Before agent starts - Memory recall
  api.on("before_agent_start", async (event) => {
    return await handleBeforeAgentStart(event);
  });

  // After agent completes - Content write
  api.on("agent_end", async (event) => {
    await handleAgentEnd(event);
  });

  // New conversation command
  api.on("command:new", async (event) => {
    await handleCommandNew(event);
  });

  console.log("[OpenClaw SiYuan] Lifecycle hooks registered");
}

/**
 * Handle before_agent_start event (memory recall)
 * @param {object} event - Event data
 * @returns {Promise<object>} Context to prepend
 */
async function handleBeforeAgentStart(event) {
  await ensureInitialized();
  const prompt = typeof event?.prompt === "string" ? event.prompt : "";
  const recallEnabled = config?.recall?.enabled ?? false;
  const linkedDocEnabled =
    config?.linkedDoc?.enabled ?? config?.recall?.linkedDoc?.enabled ?? true;
  const linkedDocIds =
    linkedDocEnabled && memoryRecall
      ? memoryRecall.extractLinkedDocIds(prompt)
      : [];

  // Pre-checks:
  // - Normal recall requires `recall.enabled=true`.
  // - Linked doc injection can run independently when `linkedDoc.enabled=true`.
  const allowLinkedDocOnly = linkedDocEnabled && linkedDocIds.length > 0;
  if (!recallEnabled && !allowLinkedDocOnly) {
    return {};
  }

  // For normal recall, keep the min length gate. Linked-doc injection bypasses it.
  if (
    recallEnabled &&
    (!prompt || prompt.length < config.recall.minPromptLength)
  ) {
    return {};
  }

  // If we need SiYuan (linked docs always do), attempt a quick reconnect.
  const needsSiyuan =
    allowLinkedDocOnly || (recallEnabled && !memoryRecall?.indexManager);
  if (!siyuanAvailable && needsSiyuan) {
    const healthResult = await siyuanClient.healthCheck();
    siyuanAvailable = healthResult.available;
    if (!siyuanAvailable) {
      console.warn(
        `[OpenClaw SiYuan] Cannot recall: SiYuan unavailable (needsSiyuan=${needsSiyuan})`,
      );
      return {};
    }
    console.log(
      `[OpenClaw SiYuan] Reconnected to SiYuan ${healthResult.version}`,
    );
  }

  try {
    console.log(
      "[OpenClaw SiYuan] Recalling memories for prompt:",
      prompt.substring(0, 50),
    );

    const result = await memoryRecall.recall(prompt);

    if (result.prependContext) {
      console.log(
        "[OpenClaw SiYuan] Injecting context from",
        result.recalledDocs?.length || 0,
        "documents",
      );
    }

    return result;
  } catch (error) {
    console.error("[OpenClaw SiYuan] Recall failed:", error.message);
    return {};
  }
}

/**
 * Handle agent_end event (content write)
 * @param {object} event - Event data
 */
async function handleAgentEnd(event) {
  await ensureInitialized();
  // Pre-checks
  if (!config.write?.enabled) {
    return;
  }

  if (!event.success) {
    return;
  }

  if (!siyuanAvailable) {
    // SiYuan might recover after startup; re-check once at write time.
    const healthResult = await siyuanClient.healthCheck();
    siyuanAvailable = healthResult.available;
    if (!siyuanAvailable) {
      console.warn("[OpenClaw SiYuan] Cannot write: SiYuan unavailable");
      return;
    }
    console.log(
      `[OpenClaw SiYuan] Reconnected to SiYuan ${healthResult.version}`,
    );
  }

  try {
    console.log("[OpenClaw SiYuan] Writing conversation to SiYuan");

    // Extract content from messages
    const content = contentWriter.extractContent(
      event.messages,
      config.write.captureStrategy,
    );

    // Check if should write
    if (!contentWriter.shouldWrite(content)) {
      console.log(
        "[OpenClaw SiYuan] Skipping write: content too short or greeting",
      );
      return;
    }

    // Determine routing
    const routing = routingEngine.route(
      content.userMessage,
      content.assistantMessage,
      event.context,
    );

    if (routing.skip) {
      console.log("[OpenClaw SiYuan] Skipping write: explicit skip command");
      return;
    }

    // Write to SiYuan
    const result = await contentWriter.write(content, routing, {
      channel: event.channel || "unknown",
      sessionId: event.sessionId,
    });

    if (result.success) {
      console.log(`[OpenClaw SiYuan] Written to ${result.path}`);
    }
  } catch (error) {
    console.error("[OpenClaw SiYuan] Write failed:", error.message);
  }
}

/**
 * Handle command:new event (session reset)
 * @param {object} _event - Event data
 */
async function handleCommandNew(_event) {
  try {
    console.log("[OpenClaw SiYuan] Handling session reset");

    // TODO: Implement session archive logic if needed
  } catch (error) {
    console.error("[OpenClaw SiYuan] Session reset failed:", error.message);
  }
}

/**
 * Get plugin status
 * @returns {object} Plugin status
 */
export function getStatus() {
  const status = {
    siyuanAvailable,
    config: {
      recallEnabled: config?.recall?.enabled,
      writeEnabled: config?.write?.enabled,
      indexEnabled: config?.index?.enabled,
    },
  };

  if (indexManager) {
    status.index = indexManager.getStatistics();
  }

  return status;
}
