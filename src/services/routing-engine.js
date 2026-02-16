/**
 * Routing decision engine for determining write targets
 * Implements 4-layer routing strategy:
 * 1. Explicit user commands
 * 2. Rule-based matching
 * 3. Context association
 * 4. Inbox fallback
 */
export class RoutingEngine {
  /**
   * @param {object} config - Plugin configuration
   */
  constructor(config) {
    this.config = config;
    this.rules = config.routing?.rules || [];
    this.inboxPath = config.routing?.inboxPath || '/OpenClaw/收件箱';
  }

  /**
   * Determine routing target for content
   * @param {string} userMessage - User's message
   * @param {string} assistantMessage - Assistant's response
   * @param {object} context - Additional context (recalled docs, etc.)
   * @returns {object} Routing decision
   */
  route(userMessage, assistantMessage, context = null) {
    // Handle empty messages
    if (!userMessage || userMessage.trim().length === 0) {
      return {
        skip: true,
        reason: 'message_too_short',
      };
    }

    // Handle very short messages (greetings, acknowledgments)
    const trimmed = userMessage.trim();
    if (trimmed.length <= 3 && !context) {
      return {
        target: this.inboxPath,
        writeMode: 'append',
        reason: 'short_message',
      };
    }

    // Layer 1: Check for explicit user commands
    const explicitResult = this.checkExplicitCommands(userMessage);
    if (explicitResult) {
      return explicitResult;
    }

    // Layer 2: Rule-based matching
    const ruleResult = this.matchRules(userMessage, assistantMessage);
    if (ruleResult) {
      return ruleResult;
    }

    // Layer 3: Context-based routing
    if (context && context.recalledDocs && context.recalledDocs.length > 0) {
      const contextResult = this.matchContext(context, userMessage);
      if (contextResult) {
        return contextResult;
      }
    }

    // Layer 4: Inbox fallback
    return {
      target: this.inboxPath,
      writeMode: 'append',
      reason: 'inbox_fallback',
    };
  }

  /**
   * Check for explicit user commands in message
   * @param {string} message - User message
   * @returns {object|null} Routing decision or null
   */
  checkExplicitCommands(message) {
    const lowerMessage = message.toLowerCase();

    // Skip commands
    if (lowerMessage.includes('不用记录') ||
        lowerMessage.includes('别保存') ||
        lowerMessage.includes('不要保存') ||
        lowerMessage.includes('don\'t save')) {
      return {
        skip: true,
        reason: 'explicit_skip',
      };
    }

    // Diary/daily note commands
    if (lowerMessage.includes('记到日记') ||
        lowerMessage.includes('写到日记') ||
        lowerMessage.includes('保存到日记')) {
      return {
        target: 'daily_note',
        writeMode: 'append',
        reason: 'explicit_command',
      };
    }

    // Save to specific project/folder
    const saveToMatch = message.match(/(?:保存|写|记)(?:到|至)(.+?(?:项目|文件夹|笔记本))/);
    if (saveToMatch) {
      const targetName = saveToMatch[1].trim();
      return {
        target: `/${targetName}`,
        writeMode: 'child_doc',
        reason: 'explicit_command',
      };
    }

    // Update existing document
    if (lowerMessage.includes('更新') &&
        (lowerMessage.includes('文档') || lowerMessage.includes('笔记'))) {
      return {
        writeMode: 'update',
        reason: 'explicit_command',
      };
    }

    return null;
  }

  /**
   * Match message against configured rules
   * @param {string} userMessage - User message
   * @param {string} assistantMessage - Assistant message
   * @returns {object|null} Routing decision or null
   */
  matchRules(userMessage, assistantMessage) {
    const combinedText = `${userMessage} ${assistantMessage}`.toLowerCase();

    // Track all matching rules with their match counts
    const matches = [];

    for (const rule of this.rules) {
      if (!rule.keywords || rule.keywords.length === 0) {
        continue;
      }

      // Count how many keywords match
      let matchCount = 0;
      for (const keyword of rule.keywords) {
        if (combinedText.includes(keyword.toLowerCase())) {
          matchCount++;
        }
      }

      if (matchCount > 0) {
        matches.push({ rule, matchCount });
      }
    }

    // If no matches, return null
    if (matches.length === 0) {
      return null;
    }

    // Return the rule with most keyword matches
    matches.sort((a, b) => b.matchCount - a.matchCount);
    const bestMatch = matches[0];

    return {
      target: bestMatch.rule.target,
      writeMode: this.determineWriteMode(bestMatch.rule.target),
      reason: 'rule_match',
      matchedRule: bestMatch.rule,
    };
  }

  /**
   * Match against context from recalled documents
   * @param {object} context - Context with recalled docs
   * @param {string} userMessage - User message
   * @returns {object|null} Routing decision or null
   */
  matchContext(context, userMessage) {
    if (!context.recalledDocs || context.recalledDocs.length === 0) {
      return null;
    }

    // Get the top-scored document
    const topDoc = context.recalledDocs[0];

    // Thresholds for context matching
    const MIN_SCORE = 0.7;
    const CONTINUATION_PHRASES = [
      '继续', '接着', '还有', '另外', '然后',
      'continue', 'also', 'additionally',
    ];

    // Check if user is continuing the discussion
    const isContinuation = CONTINUATION_PHRASES.some(phrase =>
      userMessage.toLowerCase().includes(phrase)
    );

    // Match if score is high and document was recently edited
    if (topDoc.score >= MIN_SCORE && topDoc.recentlyEdited) {
      return {
        target: topDoc.path,
        writeMode: 'append',
        reason: 'context_match',
        contextDoc: topDoc,
      };
    }

    // Also match if user explicitly continues, score is reasonable, AND doc was recently edited
    if (isContinuation && topDoc.score >= 0.6 && topDoc.recentlyEdited) {
      return {
        target: topDoc.path,
        writeMode: 'append',
        reason: 'context_match',
        contextDoc: topDoc,
      };
    }

    return null;
  }

  /**
   * Determine write mode based on target type
   * @param {string} target - Target path or special value
   * @returns {string} Write mode (append, child_doc, update)
   */
  determineWriteMode(target) {
    // Daily note is always append
    if (target === 'daily_note') {
      return 'append';
    }

    // Inbox is always append
    if (target === this.inboxPath) {
      return 'append';
    }

    // Default to append for most cases
    return 'append';
  }

  /**
   * Extract keywords from text
   * @param {string} text - Text to analyze
   * @returns {string[]} Extracted keywords
   */
  extractKeywords(text) {
    // Simple keyword extraction (can be improved with NLP)
    const stopWords = ['的', '了', '是', '在', '有', '和', '我', '你', '他',
                       'the', 'is', 'are', 'was', 'were', 'a', 'an'];

    const words = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(word => word.length > 1 && !stopWords.includes(word));

    // Return unique words
    return [...new Set(words)];
  }
}
