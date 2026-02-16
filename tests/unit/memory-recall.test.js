import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryRecall } from '../../src/services/memory-recall.js';

describe('memory recall system', () => {
  let recall;
  let mockClient;
  let config;

  beforeEach(() => {
    mockClient = {
      searchFullText: vi.fn(),
      query: vi.fn(),
      getBlockInfo: vi.fn(),
    };

    config = {
      recall: {
        enabled: true,
        minPromptLength: 10,
        maxContextTokens: 2000,
        searchPaths: ['fulltext', 'sql'],
      },
    };

    recall = new MemoryRecall(mockClient, config);
  });

  describe('intent analysis', () => {
    it('should extract keywords from prompt', () => {
      const prompt = '帮我回顾一下上周 Rust 项目的进展';
      const intent = recall.analyzeIntent(prompt);

      expect(intent.keywords).toContain('rust');
      expect(intent.keywords).toContain('项目');
      expect(intent.keywords).toContain('进展');
    });

    it('should detect time range', () => {
      const prompt = '上周做了什么';
      const intent = recall.analyzeIntent(prompt);

      expect(intent.timeRange).toBeDefined();
      expect(intent.timeRange.days).toBe(7);
    });

    it('should detect review intent type', () => {
      const prompt = '回顾一下项目进展';
      const intent = recall.analyzeIntent(prompt);

      expect(intent.type).toBe('review');
    });

    it('should detect chat intent type for greetings', () => {
      const prompt = '你好呀，最近怎么样？';
      const intent = recall.analyzeIntent(prompt);

      expect(intent.type).toBe('chat');
    });

    it('should detect command intent type for slash-prefixed messages', () => {
      const prompt = '/help show commands';
      const intent = recall.analyzeIntent(prompt);

      expect(intent.type).toBe('command');
    });

    it('should handle english prompts', () => {
      const prompt = 'Tell me about Rust project progress';
      const intent = recall.analyzeIntent(prompt);

      expect(intent.keywords).toContain('rust');
      expect(intent.keywords).toContain('project');
      expect(intent.keywords).toContain('progress');
    });
  });

  describe('recall gating', () => {
    it('should skip recall for slash commands by default', async () => {
      const result = await recall.recall('/help please show commands');

      expect(result.prependContext).toBe('');
      expect(result.skipped).toBe(true);
      expect(result.reason).toContain('intent_');
      expect(mockClient.searchFullText).not.toHaveBeenCalled();
      expect(mockClient.query).not.toHaveBeenCalled();
    });

    it('should skip recall for english explicit skip phrases', async () => {
      const result = await recall.recall("don't recall, just answer: what is Rust ownership?");

      expect(result.prependContext).toBe('');
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('explicit_skip');
      expect(mockClient.searchFullText).not.toHaveBeenCalled();
      expect(mockClient.query).not.toHaveBeenCalled();
    });

    it('should force recall when prompt asks to search notes', async () => {
      mockClient.searchFullText.mockResolvedValue([
        { id: '1', content: 'From notes', hpath: '/A', root_id: 'doc1', updated: '2026-02-14' },
      ]);
      mockClient.query.mockResolvedValue([]);

      const result = await recall.recall('查一下我的笔记：Rust ownership 是什么？');

      expect(result.skipped).not.toBe(true);
      expect(mockClient.searchFullText).toHaveBeenCalledWith(
        'Rust ownership 是什么',
        expect.objectContaining({ page: 1, size: expect.any(Number) })
      );
      expect(result.prependContext).toContain('<siyuan_context>');
    });

    it('should allow recall for slash commands when skipIntentTypes excludes command', async () => {
      const custom = new MemoryRecall(mockClient, { recall: { minPromptLength: 1, skipIntentTypes: ['chat'] } });
      mockClient.searchFullText.mockResolvedValue([
        { id: '1', content: 'cmd content', hpath: '/Cmd', root_id: 'doc1', updated: '2026-02-14' },
      ]);
      mockClient.query.mockResolvedValue([]);

      const result = await custom.recall('/find Rust in notes');

      expect(result.skipped).not.toBe(true);
      expect(mockClient.searchFullText).toHaveBeenCalled();
    });

    it('should strip english force prefix before searching', async () => {
      mockClient.searchFullText.mockResolvedValue([
        { id: '1', content: 'From notes', hpath: '/A', root_id: 'doc1', updated: '2026-02-14' },
      ]);
      mockClient.query.mockResolvedValue([]);

      await recall.recall('search my notes for Rust ownership rules');

      expect(mockClient.searchFullText).toHaveBeenCalledWith(
        'Rust ownership rules',
        expect.objectContaining({ page: 1, size: expect.any(Number) })
      );
    });
  });

  describe('multi-path search', () => {
    it('should search using full-text search', async () => {
      const mockBlocks = [
        { id: '1', content: 'Rust project update', hpath: '/项目/Rust' },
      ];

      mockClient.searchFullText.mockResolvedValue(mockBlocks);

      const results = await recall.searchFullText('Rust project');

      expect(results).toEqual(mockBlocks);
      expect(mockClient.searchFullText).toHaveBeenCalledWith('Rust project');
    });

    it('should search using SQL query', async () => {
      const mockBlocks = [
        { id: '1', content: 'Rust content', updated: '2026-02-10' },
      ];

      mockClient.query.mockResolvedValue(mockBlocks);

      const results = await recall.searchSQL('Rust', { days: 7 });

      expect(results).toEqual(mockBlocks);
      expect(mockClient.query).toHaveBeenCalled();
    });

    it('should combine results from multiple paths', async () => {
      mockClient.searchFullText.mockResolvedValue([
        { id: '1', content: 'Result from fulltext' },
      ]);

      mockClient.query.mockResolvedValue([
        { id: '2', content: 'Result from SQL' },
      ]);

      const results = await recall.search('test query', { timeRange: { days: 7 } });

      expect(results.length).toBeGreaterThan(0);
    });

    it('should deduplicate results by block id', async () => {
      mockClient.searchFullText.mockResolvedValue([
        { id: '1', content: 'Same block' },
      ]);

      mockClient.query.mockResolvedValue([
        { id: '1', content: 'Same block' },
      ]);

      const results = await recall.search('test', { timeRange: { days: 7 } });

      const ids = results.map(r => r.id);
      const uniqueIds = [...new Set(ids)];

      expect(ids.length).toBe(uniqueIds.length);
    });

    it('should perform two-stage retrieval with rerank + diversity cap', async () => {
      // Make final results small so assertions are easy.
      config.recall.twoStage = {
        enabled: true,
        candidateLimitPerPath: 50,
        finalBlockLimit: 5,
        perDocBlockCap: 2,
      };

      mockClient.searchFullText.mockResolvedValue([
        ...Array.from({ length: 20 }, (_, i) => ({
          id: `a${i}`,
          root_id: 'docA',
          hpath: '/A',
          content: `Rust content A ${i}`,
          updated: '2026-02-15',
        })),
        ...Array.from({ length: 20 }, (_, i) => ({
          id: `b${i}`,
          root_id: 'docB',
          hpath: '/B',
          content: `Rust content B ${i}`,
          updated: '2026-02-14',
        })),
        ...Array.from({ length: 20 }, (_, i) => ({
          id: `c${i}`,
          root_id: 'docC',
          hpath: '/C',
          content: `Rust content C ${i}`,
          updated: '2026-02-13',
        })),
      ]);
      mockClient.query.mockResolvedValue([]);

      const results = await recall.search('Rust', { keywords: ['rust'] });

      expect(results).toHaveLength(5);
      const byDoc = results.reduce((acc, r) => {
        acc[r.root_id] = (acc[r.root_id] || 0) + 1;
        return acc;
      }, {});
      expect(byDoc.docA).toBeLessThanOrEqual(2);
      expect(byDoc.docB).toBeLessThanOrEqual(2);
      expect(byDoc.docC).toBeLessThanOrEqual(2);
    });
  });

  describe('result aggregation', () => {
    it('should group blocks by document', () => {
      const blocks = [
        { id: '1', content: 'Block 1', hpath: '/项目/Rust', root_id: 'doc1' },
        { id: '2', content: 'Block 2', hpath: '/项目/Rust', root_id: 'doc1' },
        { id: '3', content: 'Block 3', hpath: '/日记/2026-02-10', root_id: 'doc2' },
      ];

      const grouped = recall.groupByDocument(blocks);

      expect(Object.keys(grouped)).toHaveLength(2);
      expect(grouped['doc1'].blocks).toHaveLength(2);
      expect(grouped['doc2'].blocks).toHaveLength(1);
    });

    it('should calculate document relevance score', () => {
      const doc = {
        blocks: [
          { id: '1', content: 'Rust project' },
          { id: '2', content: 'Rust implementation' },
        ],
        path: '/项目/Rust重构',
      };

      const score = recall.calculateRelevanceScore(doc, ['rust', 'project']);

      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    it('should sort documents by relevance', () => {
      const blocks = [
        { id: '1', content: 'Low relevance', hpath: '/other', root_id: 'doc1' },
        { id: '2', content: 'Rust project implementation', hpath: '/项目/Rust', root_id: 'doc2' },
        { id: '3', content: 'Rust advanced features', hpath: '/学习/Rust', root_id: 'doc3' },
      ];

      mockClient.getBlockInfo.mockResolvedValue({ updated: '2026-02-15' });

      const results = recall.aggregateResults(blocks, ['rust', 'project']);

      expect(results[0].score).toBeGreaterThan(results[1].score);
    });
  });

  describe('context formatting', () => {
    it('should format recalled documents as context', () => {
      const docs = [
        {
          path: '/项目/Rust重构',
          blocks: [
            { content: '完成了模块A的重构' },
            { content: '性能提升30%' },
          ],
          score: 0.85,
          updated: '2026-02-14',
        },
      ];

      const context = recall.formatContext(docs);

      expect(context).toContain('/项目/Rust重构');
      expect(context).toContain('完成了模块A的重构');
      expect(context).toContain('性能提升30%');
    });

    it('should limit context by token budget', () => {
      const docs = [
        {
          path: '/doc1',
          blocks: Array(100).fill({ content: 'Very long content block' }),
          score: 0.8,
        },
      ];

      const shortConfig = {
        recall: { maxContextTokens: 500 },
      };

      const shortRecall = new MemoryRecall(mockClient, shortConfig);
      const context = shortRecall.formatContext(docs);

      // Rough estimate: context should be truncated
      expect(context.length).toBeLessThan(5000);
    });

    it('should include document metadata', () => {
      const docs = [
        {
          path: '/项目/Rust',
          blocks: [{ content: 'Test' }],
          score: 0.9,
          updated: '2026-02-14',
        },
      ];

      const context = recall.formatContext(docs);

      expect(context).toContain('2026-02-14');
      expect(context).toContain('/项目/Rust');
    });
  });

  describe('full recall flow', () => {
    it('should return empty context for short prompts', async () => {
      const result = await recall.recall('Hi');

      expect(result.prependContext).toBe('');
    });

    it('should skip recall for greeting/small-talk prompts', async () => {
      const result = await recall.recall('你好呀，最近怎么样？');

      expect(result.prependContext).toBe('');
      expect(result.skipped).toBe(true);
      expect(mockClient.searchFullText).not.toHaveBeenCalled();
      expect(mockClient.query).not.toHaveBeenCalled();
    });

    it('should skip recall when explicitly disabled in prompt', async () => {
      const result = await recall.recall('不用回忆，直接回答：Rust 是什么？');

      expect(result.prependContext).toBe('');
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('explicit_skip');
      expect(mockClient.searchFullText).not.toHaveBeenCalled();
      expect(mockClient.query).not.toHaveBeenCalled();
    });

    it('should perform full recall flow', async () => {
      mockClient.searchFullText.mockResolvedValue([
        {
          id: '1',
          content: 'Rust project progress',
          hpath: '/项目/Rust',
          root_id: 'doc1',
        },
      ]);

      mockClient.query.mockResolvedValue([]);
      mockClient.getBlockInfo.mockResolvedValue({
        id: 'doc1',
        hpath: '/项目/Rust',
        updated: '2026-02-14',
      });

      const result = await recall.recall('Tell me about Rust project');

      expect(result.prependContext).toBeDefined();
      expect(result.prependContext).toContain('Rust');
      expect(result.recalledDocs).toBeDefined();
      expect(result.recalledDocs.length).toBeGreaterThan(0);
    });

    it('should handle search errors gracefully', async () => {
      mockClient.searchFullText.mockRejectedValue(new Error('Search failed'));
      mockClient.query.mockRejectedValue(new Error('Query failed'));

      const result = await recall.recall('Test query');

      expect(result.prependContext).toBe('');
      expect(result.error).toBeDefined();
    });
  });
});
