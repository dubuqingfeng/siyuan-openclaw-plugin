import { describe, it, expect, beforeEach, vi } from 'vitest';

const { requestMock, createMock } = vi.hoisted(() => {
  const requestMock = vi.fn();
  const createMock = vi.fn(() => ({ request: requestMock }));
  return { requestMock, createMock };
});

vi.mock('axios', () => ({
  default: {
    create: createMock,
  },
}));

const { SiYuanClient } = await import('../../src/clients/siyuan-client.js');

describe('siyuan api client', () => {
  let client;
  const mockConfig = {
    apiUrl: 'http://127.0.0.1:6806',
    apiToken: 'test-token',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    client = new SiYuanClient(mockConfig);
  });

  describe('constructor', () => {
    it('should create client with config', () => {
      expect(client).toBeDefined();
      expect(client.apiUrl).toBe('http://127.0.0.1:6806');
    });

    it('should throw error when apiUrl is missing', () => {
      expect(() => new SiYuanClient({})).toThrow('apiUrl is required');
    });
  });

  describe('health check', () => {
    it('should check siyuan availability', async () => {
      requestMock.mockResolvedValueOnce({
        data: { code: 0, data: { version: '2.8.0' } },
      });

      const result = await client.healthCheck();

      expect(result.available).toBe(true);
      expect(result.version).toBe('2.8.0');
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'http://127.0.0.1:6806',
          headers: expect.objectContaining({
            Authorization: 'Token test-token',
          }),
        })
      );
      expect(requestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: '/api/system/version',
          method: 'post',
        })
      );
    });

    it('should return unavailable when request fails', async () => {
      requestMock.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await client.healthCheck();

      expect(result.available).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('sql query', () => {
    it('should execute sql query', async () => {
      const mockData = [
        { id: '1', content: 'Test block' },
      ];

      requestMock.mockResolvedValueOnce({
        data: { code: 0, data: mockData },
      });

      const result = await client.query('SELECT * FROM blocks LIMIT 1');

      expect(result).toEqual(mockData);
      expect(requestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: '/api/query/sql',
          method: 'post',
          data: { stmt: 'SELECT * FROM blocks LIMIT 1' },
        })
      );
    });

    it('should throw error when query fails', async () => {
      requestMock.mockResolvedValueOnce({
        data: { code: -1, msg: 'SQL error' },
      });

      await expect(client.query('INVALID SQL')).rejects.toThrow('SQL error');
    });
  });

  describe('full-text search', () => {
    it('should search blocks by content', async () => {
      const mockBlocks = [
        { id: '1', content: 'Rust project' },
        { id: '2', content: 'Rust tutorial' },
      ];

      requestMock.mockResolvedValueOnce({
        data: { code: 0, data: { blocks: mockBlocks } },
      });

      const result = await client.searchFullText('Rust');

      expect(result).toEqual(mockBlocks);
      expect(requestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: '/api/search/fullTextSearchBlock',
          method: 'post',
          data: { query: 'Rust' },
        })
      );
    });
  });

  describe('block operations', () => {
    it('should get block info', async () => {
      const mockBlock = {
        id: '123',
        content: 'Test',
        hpath: '/notebook/document',
      };

      requestMock.mockResolvedValueOnce({
        data: { code: 0, data: mockBlock },
      });

      const result = await client.getBlockInfo('123');

      expect(result).toEqual(mockBlock);
    });

    it('should append block', async () => {
      requestMock.mockResolvedValueOnce({
        data: { code: 0, data: [{ id: 'new-block-id' }] },
      });

      const result = await client.appendBlock({
        parentID: 'doc-id',
        data: '## New content',
        dataType: 'markdown',
      });

      expect(result.id).toBe('new-block-id');
    });

    it('should throw helpful error when appendBlock returns null data', async () => {
      requestMock.mockResolvedValueOnce({
        data: { code: 0, data: null },
      });

      await expect(
        client.appendBlock({
          parentID: 'doc-id',
          data: '## New content',
          dataType: 'markdown',
        })
      ).rejects.toThrow(/appendBlock: unexpected response/i);
    });

    it('should update block', async () => {
      requestMock.mockResolvedValueOnce({
        data: { code: 0 },
      });

      await client.updateBlock({
        id: 'block-id',
        data: 'Updated content',
        dataType: 'markdown',
      });

      expect(requestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: '/api/block/updateBlock',
          method: 'post',
        })
      );
    });
  });

  describe('document operations', () => {
    it('should list notebooks', async () => {
      const mockNotebooks = [
        { id: 'nb1', name: '日记' },
        { id: 'nb2', name: '项目' },
      ];

      requestMock.mockResolvedValueOnce({
        data: { code: 0, data: { notebooks: mockNotebooks } },
      });

      const result = await client.listNotebooks();

      expect(result).toEqual(mockNotebooks);
    });

    it('should create document with markdown', async () => {
      requestMock.mockResolvedValueOnce({
        data: { code: 0, data: { id: 'new-doc-id' } },
      });

      const result = await client.createDocWithMd({
        notebook: 'nb1',
        path: '/OpenClaw/收件箱',
        markdown: '# Test Document',
      });

      expect(result.id).toBe('new-doc-id');
    });
  });

  describe('attribute operations', () => {
    it('should set block attributes', async () => {
      requestMock.mockResolvedValueOnce({
        data: { code: 0 },
      });

      await client.setBlockAttrs('block-id', {
        'custom-source': 'openclaw',
        'custom-channel': 'whatsapp',
      });

      expect(requestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: '/api/attr/setBlockAttrs',
          method: 'post',
          data: expect.objectContaining({
            attrs: expect.objectContaining({
              'custom-source': 'openclaw',
            }),
          }),
        })
      );
    });
  });
});
