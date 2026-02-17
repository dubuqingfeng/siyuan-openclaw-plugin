import axios from "axios";

/**
 * SiYuan API client for interacting with SiYuan note system
 */
export class SiYuanClient {
  /**
   * @param {object} config - Configuration object
   * @param {string} config.apiUrl - SiYuan API base URL
   * @param {string} config.apiToken - SiYuan API token
   */
  constructor(config) {
    if (!config.apiUrl) {
      throw new Error("apiUrl is required");
    }

    this.apiUrl = config.apiUrl;
    this.apiToken = config.apiToken || "";

    const headers = {
      "Content-Type": "application/json",
    };
    if (this.apiToken) {
      headers.Authorization = `Token ${this.apiToken}`;
    }

    this.http = axios.create({
      baseURL: this.apiUrl,
      headers,
    });
  }

  /**
   * Make API request to SiYuan
   * @param {string} endpoint - API endpoint path
   * @param {object} data - Request body data
   * @returns {Promise<object>} Response data
   */
  async request(endpoint, data = null) {
    const response = await this.http.request({
      url: endpoint,
      method: "post",
      ...(data ? { data } : {}),
    });
    const result = response.data;

    if (result.code !== 0) {
      throw new Error(result.msg || "API request failed");
    }

    return result.data;
  }

  /**
   * Check if SiYuan is available
   * @returns {Promise<object>} Health check result
   */
  async healthCheck() {
    try {
      const data = await this.request("/api/system/version");
      return {
        available: true,
        version: data?.version ?? data,
      };
    } catch (error) {
      return {
        available: false,
        error: error.message,
      };
    }
  }

  /**
   * Execute SQL query
   * @param {string} stmt - SQL statement
   * @returns {Promise<Array>} Query results
   */
  async query(stmt) {
    return await this.request("/api/query/sql", { stmt });
  }

  /**
   * Search blocks by full-text search
   * @param {string} query - Search query
   * @param {object} options - Search options
   * @returns {Promise<Array>} Matched blocks
   */
  async searchFullText(query, options = {}) {
    const data = await this.request("/api/search/fullTextSearchBlock", {
      query,
      ...options,
    });
    return data.blocks || [];
  }

  /**
   * Get block information
   * @param {string} id - Block ID
   * @returns {Promise<object>} Block information
   */
  async getBlockInfo(id) {
    return await this.request("/api/block/getBlockInfo", { id });
  }

  /**
   * Get block kramdown source
   * @param {string} id - Block ID
   * @returns {Promise<{id: string, kramdown: string}>}
   */
  async getBlockKramdown(id) {
    return await this.request("/api/block/getBlockKramdown", { id });
  }

  /**
   * Append block to parent
   * @param {object} params - Block parameters
   * @param {string} params.parentID - Parent block ID
   * @param {string} params.data - Block content
   * @param {string} params.dataType - Content type (markdown, dom)
   * @returns {Promise<object>} Created block info
   */
  async appendBlock(params) {
    const response = await this.http.request({
      url: "/api/block/appendBlock",
      method: "post",
      data: params,
    });
    const result = response.data;
    if (result?.code !== 0) {
      throw new Error(result?.msg || "API request failed");
    }
    let data = result?.data;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        // Keep as-is; some gateways might return a plain id string.
      }
    }

    // Different SiYuan versions / proxies may return different shapes.
    // Normalize to an object that contains at least `{ id }`.
    if (Array.isArray(data)) {
      if (data.length > 0) return data[0];
    } else if (data && typeof data === "object") {
      if (typeof data.id === "string") return data;
      if (Array.isArray(data.ids) && typeof data.ids[0] === "string")
        return { id: data.ids[0] };
      if (Array.isArray(data.blocks) && data.blocks.length > 0)
        return data.blocks[0];
    } else if (typeof data === "string" && data.trim()) {
      // Some proxies may return the created block id directly.
      return { id: data.trim() };
    }

    throw new Error(
      `appendBlock: unexpected response: ${
        result == null ? "null" : JSON.stringify(result)
      }`,
    );
  }

  /**
   * Update block content
   * @param {object} params - Update parameters
   * @param {string} params.id - Block ID
   * @param {string} params.data - New content
   * @param {string} params.dataType - Content type
   * @returns {Promise<void>}
   */
  async updateBlock(params) {
    await this.request("/api/block/updateBlock", params);
  }

  /**
   * List all notebooks
   * @returns {Promise<Array>} List of notebooks
   */
  async listNotebooks() {
    console.log("lsnotebooks");
    // SiYuan API endpoints typically expect POST even when there's no payload.
    const data = await this.request("/api/notebook/lsNotebooks", {});
    console.log(data);
    return data.notebooks || [];
  }

  /**
   * Create document with markdown content
   * @param {object} params - Document parameters
   * @param {string} params.notebook - Notebook ID
   * @param {string} params.path - Document path
   * @param {string} params.markdown - Markdown content
   * @returns {Promise<object>} Created document info
   */
  async createDocWithMd(params) {
    const response = await this.http.request({
      url: "/api/filetree/createDocWithMd",
      method: "post",
      data: params,
    });
    const result = response.data;
    if (result?.code !== 0) {
      throw new Error(result?.msg || "API request failed");
    }
    let data = result?.data;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        // Keep as-is; some gateways might return a plain id string.
      }
    }

    if (data && typeof data === "object") return data;
    if (typeof data === "string") return { id: data };

    throw new Error(
      `createDocWithMd: unexpected response: ${
        result == null ? "null" : JSON.stringify(result)
      }`,
    );
  }

  /**
   * Set block custom attributes
   * @param {string} id - Block ID
   * @param {object} attrs - Attributes to set
   * @returns {Promise<void>}
   */
  async setBlockAttrs(id, attrs) {
    await this.request("/api/attr/setBlockAttrs", { id, attrs });
  }

  /**
   * Get document by path
   * @param {string} hpath - Document hierarchical path
   * @returns {Promise<object|null>} Document info or null if not found
   */
  async getDocByPath(hpath) {
    const stmt = `SELECT * FROM blocks WHERE type='d' AND hpath = '${hpath}'`;
    const results = await this.query(stmt);
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Get blocks updated after specific time
   * @param {string} timestamp - ISO timestamp
   * @param {number} limit - Maximum results
   * @returns {Promise<Array>} Updated blocks
   */
  async getUpdatedBlocks(timestamp, limit = 500) {
    const stmt = `
      SELECT * FROM blocks
      WHERE updated > '${timestamp}'
      ORDER BY updated DESC
      LIMIT ${limit}
    `;
    return await this.query(stmt);
  }
}
