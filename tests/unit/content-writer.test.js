import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ContentWriter } from '../../src/services/content-writer.js';

describe('content write system', () => {
  let writer;
  let mockClient;
  let config;

  beforeEach(() => {
    mockClient = {
      query: vi.fn(),
      getDocByPath: vi.fn(),
      listNotebooks: vi.fn(),
      createDocWithMd: vi.fn(),
      appendBlock: vi.fn(),
      updateBlock: vi.fn(),
      setBlockAttrs: vi.fn(),
    };

    config = {
      write: {
        enabled: true,
        captureStrategy: 'smart',
        minContentLength: 50,
        throttleMs: 3000,
      },
      routing: {
        inboxPath: '/OpenClaw/收件箱',
      },
    };

    writer = new ContentWriter(mockClient, config);
  });

  describe('content extraction', () => {
    it('should extract last turn with smart strategy', () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
        { role: 'user', content: 'Tell me about Rust' },
        { role: 'assistant', content: 'Rust is a systems programming language...' },
      ];

      const content = writer.extractContent(messages, 'smart');

      expect(content.userMessage).toBe('Tell me about Rust');
      expect(content.assistantMessage).toContain('Rust is');
    });

    it('should extract full session', () => {
      const messages = [
        { role: 'user', content: 'Question 1' },
        { role: 'assistant', content: 'Answer 1' },
        { role: 'user', content: 'Question 2' },
        { role: 'assistant', content: 'Answer 2' },
      ];

      const content = writer.extractContent(messages, 'full_session');

      expect(content.fullConversation).toBeDefined();
      expect(content.fullConversation.length).toBe(4);
    });

    it('should filter out short messages with smart strategy', () => {
      const messages = [
        { role: 'user', content: '好的' },
        { role: 'assistant', content: '还有其他问题吗？' },
        { role: 'user', content: 'Tell me about a complex topic with detailed explanation' },
        { role: 'assistant', content: 'Here is a detailed explanation...' },
      ];

      const content = writer.extractContent(messages, 'smart');

      expect(content.userMessage).not.toBe('好的');
      expect(content.userMessage).toContain('complex topic');
    });

    it('should handle empty messages array', () => {
      const content = writer.extractContent([], 'smart');

      expect(content.userMessage).toBe('');
      expect(content.assistantMessage).toBe('');
    });

    it('should normalize non-string message content (array/object shapes)', () => {
      const messages = [
        { role: 'user', content: [{ type: 'text', text: 'Tell me' }, { type: 'text', text: ' about Rust' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Rust is great.' }] },
      ];

      const content = writer.extractContent(messages, 'smart');

      expect(content.userMessage).toBe('Tell me about Rust');
      expect(content.assistantMessage).toBe('Rust is great.');
    });
  });

  describe('content filtering', () => {
    it('should filter out greeting messages', () => {
      const result = writer.shouldWrite({
        userMessage: '你好',
        assistantMessage: '你好！有什么可以帮助你的？',
      });

      expect(result).toBe(false);
    });

    it('should filter out very short conversations', () => {
      const result = writer.shouldWrite({
        userMessage: '好',
        assistantMessage: '好的',
      });

      expect(result).toBe(false);
    });

    it('should accept substantive content', () => {
      const result = writer.shouldWrite({
        userMessage: 'Explain how Rust memory management works with ownership',
        assistantMessage: 'Rust uses ownership system with three main rules...',
      });

      expect(result).toBe(true);
    });

    it('should accept content with code blocks', () => {
      const result = writer.shouldWrite({
        userMessage: 'Show me an example',
        assistantMessage: '```rust\nfn main() {}\n```',
      });

      expect(result).toBe(true);
    });
  });

  describe('content formatting', () => {
    it('should format with daily_note template', () => {
      const formatted = writer.formatContent(
        {
          userMessage: 'What is Rust?',
          assistantMessage: 'Rust is a programming language',
        },
        {
          target: 'daily_note',
          writeMode: 'append',
        }
      );

      expect(formatted).toContain('###');
      expect(formatted).toContain('What is Rust?');
      expect(formatted).toContain('Rust is a programming language');
      expect(formatted).toContain('#openclaw');
    });

    it('should format with append template', () => {
      const formatted = writer.formatContent(
        {
          userMessage: 'Continue discussion',
          assistantMessage: 'Here are more details',
        },
        {
          target: '/项目/Rust重构',
          writeMode: 'append',
        }
      );

      expect(formatted).toContain('---');
      expect(formatted).toContain('via OpenClaw');
    });

    it('should format with inbox template', () => {
      const formatted = writer.formatContent(
        {
          userMessage: 'Random question',
          assistantMessage: 'Random answer',
        },
        {
          target: '/OpenClaw/收件箱',
          writeMode: 'append',
        }
      );

      expect(formatted).toContain('📥');
      expect(formatted).toContain('#待整理');
    });

    it('should include timestamp', () => {
      const formatted = writer.formatContent(
        { userMessage: 'Q', assistantMessage: 'A' },
        { target: 'daily_note' }
      );

      expect(formatted).toMatch(/\d{2}:\d{2}/); // HH:MM format
    });
  });

  describe('write operations', () => {
    it('should create document if not exists', async () => {
      const routing = {
        target: '/OpenClaw/新文档',
        writeMode: 'append',
      };

      mockClient.getDocByPath.mockResolvedValue(null);
      mockClient.listNotebooks.mockResolvedValue([
        { id: 'nb-openclaw', name: 'OpenClaw' },
        { id: 'nb-other', name: 'Other' },
      ]);
      mockClient.createDocWithMd.mockResolvedValue({ id: 'new-doc-id' });
      mockClient.appendBlock.mockResolvedValue({ id: 'block-id' });

      await writer.write(
        { userMessage: 'Test', assistantMessage: 'Response' },
        routing
      );

      expect(mockClient.createDocWithMd).toHaveBeenCalled();
      expect(mockClient.createDocWithMd).toHaveBeenCalledWith(
        expect.objectContaining({
          notebook: 'nb-openclaw',
        })
      );
      expect(mockClient.appendBlock).toHaveBeenCalled();
    });

    it('should append to existing document', async () => {
      const routing = {
        target: '/OpenClaw/收件箱',
        writeMode: 'append',
      };

      mockClient.getDocByPath.mockResolvedValue({ id: 'existing-doc-id' });
      mockClient.appendBlock.mockResolvedValue({ id: 'block-id' });

      await writer.write(
        { userMessage: 'Test', assistantMessage: 'Response' },
        routing
      );

      expect(mockClient.createDocWithMd).not.toHaveBeenCalled();
      expect(mockClient.appendBlock).toHaveBeenCalledWith(
        expect.objectContaining({
          parentID: 'existing-doc-id',
        })
      );
    });

    it('should set block attributes after write', async () => {
      const routing = { target: '/Test', writeMode: 'append' };

      mockClient.getDocByPath.mockResolvedValue({ id: 'doc-id' });
      mockClient.appendBlock.mockResolvedValue({ id: 'new-block-id' });
      mockClient.setBlockAttrs.mockResolvedValue();

      await writer.write(
        { userMessage: 'Test', assistantMessage: 'Response' },
        routing,
        { channel: 'whatsapp', sessionId: 'session-123' }
      );

      expect(mockClient.setBlockAttrs).toHaveBeenCalledWith(
        'new-block-id',
        expect.objectContaining({
          'custom-source': 'openclaw',
        })
      );
    });

    it('should handle daily_note special case', async () => {
      const routing = {
        target: 'daily_note',
        writeMode: 'append',
      };

      // Mock today's daily note path
      const today = new Date().toISOString().split('T')[0];
      mockClient.getDocByPath.mockResolvedValue({ id: 'daily-note-id' });
      mockClient.appendBlock.mockResolvedValue({ id: 'block-id' });

      await writer.write(
        { userMessage: 'Daily entry', assistantMessage: 'Response' },
        routing
      );

      expect(mockClient.getDocByPath).toHaveBeenCalledWith(
        expect.stringContaining(today)
      );
    });

    it('should handle write errors gracefully', async () => {
      const routing = { target: '/Test', writeMode: 'append' };

      mockClient.getDocByPath.mockRejectedValue(new Error('Network error'));

      await expect(
        writer.write(
          { userMessage: 'Test', assistantMessage: 'Response' },
          routing
        )
      ).rejects.toThrow('Network error');
    });
  });

  describe('deduplication', () => {
    it('should detect duplicate content', () => {
      const content = {
        userMessage: 'Same question',
        assistantMessage: 'Same answer',
      };

      const hash1 = writer.generateContentHash(content);
      const hash2 = writer.generateContentHash(content);

      expect(hash1).toBe(hash2);
    });

    it('should generate different hashes for different content', () => {
      const content1 = {
        userMessage: 'Question 1',
        assistantMessage: 'Answer 1',
      };

      const content2 = {
        userMessage: 'Question 2',
        assistantMessage: 'Answer 2',
      };

      const hash1 = writer.generateContentHash(content1);
      const hash2 = writer.generateContentHash(content2);

      expect(hash1).not.toBe(hash2);
    });
  });
});
