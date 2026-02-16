import { describe, it, expect, beforeEach } from 'vitest';
import { RoutingEngine } from '../../src/services/routing-engine.js';

describe('routing decision engine', () => {
  let engine;
  let config;

  beforeEach(() => {
    config = {
      routing: {
        rules: [
          {
            keywords: ['日记', '今天', '记录'],
            target: 'daily_note',
          },
          {
            keywords: ['会议', 'meeting'],
            target: '/工作/会议记录',
          },
          {
            keywords: ['TODO', '任务', '待办'],
            target: '/GTD/任务箱',
          },
          {
            keywords: ['代码', 'bug', 'feature'],
            target: '/开发笔记',
          },
        ],
        inboxPath: '/OpenClaw/收件箱',
        archivePath: '/OpenClaw/对话归档',
      },
    };
    engine = new RoutingEngine(config);
  });

  describe('explicit command detection', () => {
    it('should detect "记到日记里" command', () => {
      const userMessage = '今天学了 Rust，记到日记里';
      const result = engine.route(userMessage, '');

      expect(result.target).toBe('daily_note');
      expect(result.reason).toBe('explicit_command');
    });

    it('should detect "保存到XX项目" command', () => {
      const userMessage = '这个方案不错，保存到 Rust 项目';
      const result = engine.route(userMessage, '');

      expect(result.target).toContain('Rust');
      expect(result.reason).toBe('explicit_command');
    });

    it('should detect "更新XX文档" command', () => {
      const userMessage = '更新项目进度文档';
      const result = engine.route(userMessage, '');

      expect(result.writeMode).toBe('update');
      expect(result.reason).toBe('explicit_command');
    });

    it('should detect "不用记录" skip command', () => {
      const userMessage = '这个不用记录，谢谢';
      const result = engine.route(userMessage, '');

      expect(result.skip).toBe(true);
      expect(result.reason).toBe('explicit_skip');
    });

    it('should detect "别保存" skip command', () => {
      const userMessage = '别保存这个对话';
      const result = engine.route(userMessage, '');

      expect(result.skip).toBe(true);
      expect(result.reason).toBe('explicit_skip');
    });
  });

  describe('rule-based routing', () => {
    it('should match diary keywords', () => {
      const userMessage = '今天遇到一个问题';
      const result = engine.route(userMessage, '');

      expect(result.target).toBe('daily_note');
      expect(result.reason).toBe('rule_match');
    });

    it('should match meeting keywords', () => {
      const userMessage = '参加了一个重要的会议';
      const result = engine.route(userMessage, '');

      expect(result.target).toBe('/工作/会议记录');
      expect(result.reason).toBe('rule_match');
    });

    it('should match todo keywords', () => {
      const userMessage = '添加一个 TODO 任务';
      const result = engine.route(userMessage, '');

      expect(result.target).toBe('/GTD/任务箱');
      expect(result.reason).toBe('rule_match');
    });

    it('should match code keywords', () => {
      const userMessage = '修复了一个 bug';
      const result = engine.route(userMessage, '');

      expect(result.target).toBe('/开发笔记');
      expect(result.reason).toBe('rule_match');
    });

    it('should match first rule when multiple rules match', () => {
      const userMessage = '今天的会议记录';
      const result = engine.route(userMessage, '');

      // "今天" matches diary rule first
      expect(result.target).toBe('daily_note');
    });
  });

  describe('context-based routing', () => {
    it('should route to context document when score is high', () => {
      const context = {
        recalledDocs: [
          { path: '/项目/Rust重构', score: 0.85, recentlyEdited: true },
        ],
      };

      const result = engine.route('继续讨论这个话题', '', context);

      expect(result.target).toBe('/项目/Rust重构');
      expect(result.writeMode).toBe('append');
      expect(result.reason).toBe('context_match');
    });

    it('should ignore context when score is low', () => {
      const context = {
        recalledDocs: [
          { path: '/项目/Rust重构', score: 0.5, recentlyEdited: true },
        ],
      };

      const result = engine.route('随便聊聊', '', context);

      expect(result.target).toBe('/OpenClaw/收件箱');
      expect(result.reason).toBe('inbox_fallback');
    });

    it('should ignore context when document not recently edited', () => {
      const context = {
        recalledDocs: [
          { path: '/项目/旧项目', score: 0.85, recentlyEdited: false },
        ],
      };

      const result = engine.route('继续讨论', '', context);

      expect(result.target).toBe('/OpenClaw/收件箱');
    });
  });

  describe('inbox fallback', () => {
    it('should use inbox when no rules match', () => {
      const userMessage = 'random conversation';
      const result = engine.route(userMessage, '');

      expect(result.target).toBe('/OpenClaw/收件箱');
      expect(result.reason).toBe('inbox_fallback');
    });

    it('should use inbox for short messages', () => {
      const userMessage = '好的';
      const result = engine.route(userMessage, '');

      expect(result.target).toBe('/OpenClaw/收件箱');
    });
  });

  describe('write mode determination', () => {
    it('should use append mode by default', () => {
      const result = engine.route('今天学习了 Rust', '');

      expect(result.writeMode).toBe('append');
    });

    it('should use child_doc mode for explicit save commands', () => {
      const result = engine.route('保存到项目文件夹', '');

      expect(result.writeMode).toBe('child_doc');
    });

    it('should use update mode for update commands', () => {
      const result = engine.route('更新这个文档', '');

      expect(result.writeMode).toBe('update');
    });
  });

  describe('edge cases', () => {
    it('should handle empty messages', () => {
      const result = engine.route('', '');

      expect(result.skip).toBe(true);
    });

    it('should handle null context', () => {
      const result = engine.route('test message', '', null);

      expect(result).toBeDefined();
      expect(result.target).toBeDefined();
    });

    it('should handle missing config rules', () => {
      const minimalEngine = new RoutingEngine({
        routing: { inboxPath: '/收件箱' },
      });

      const result = minimalEngine.route('test', '');

      expect(result.target).toBe('/收件箱');
    });
  });
});
