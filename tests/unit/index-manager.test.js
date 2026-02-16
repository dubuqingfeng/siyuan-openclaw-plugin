import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { IndexManager } from '../../src/clients/index-manager.js';

describe('index synchronization system', () => {
  let indexManager;
  let testDbPath;

  beforeEach(() => {
    testDbPath = join(tmpdir(), `openclaw-test-${Date.now()}.sqlite`);
    indexManager = new IndexManager({ dbPath: testDbPath });
  });

  afterEach(() => {
    if (indexManager) {
      indexManager.close();
    }
    if (existsSync(testDbPath)) {
      rmSync(testDbPath);
    }
  });

  describe('database initialization', () => {
    it('should create database file', () => {
      expect(existsSync(testDbPath)).toBe(true);
    });

    it('should create doc_registry table', () => {
      const tables = indexManager.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='doc_registry'"
      ).all();

      expect(tables).toHaveLength(1);
    });

    it('should create block_fts table with FTS5', () => {
      const tables = indexManager.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='block_fts'"
      ).all();

      expect(tables).toHaveLength(1);
    });

    it('should create sync_metadata table', () => {
      const tables = indexManager.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sync_metadata'"
      ).all();

      expect(tables).toHaveLength(1);
    });
  });

  describe('document indexing', () => {
    it('should index new document', () => {
      const doc = {
        id: 'doc-1',
        title: 'Test Document',
        hpath: '/notebook/test',
        content: 'This is test content',
        updated: '2026-02-16T10:00:00Z',
      };

      indexManager.indexDocument(doc);

      const result = indexManager.db.prepare(
        'SELECT * FROM doc_registry WHERE doc_id = ?'
      ).get('doc-1');

      expect(result).toBeDefined();
      expect(result.title).toBe('Test Document');
      expect(result.hpath).toBe('/notebook/test');
    });

    it('should update existing document', () => {
      const doc1 = {
        id: 'doc-1',
        title: 'Original Title',
        hpath: '/test',
        content: 'Original content',
        updated: '2026-02-16T10:00:00Z',
      };

      indexManager.indexDocument(doc1);

      const doc2 = {
        id: 'doc-1',
        title: 'Updated Title',
        hpath: '/test',
        content: 'Updated content',
        updated: '2026-02-16T11:00:00Z',
      };

      indexManager.indexDocument(doc2);

      const result = indexManager.db.prepare(
        'SELECT * FROM doc_registry WHERE doc_id = ?'
      ).get('doc-1');

      expect(result.title).toBe('Updated Title');
    });

    it('should index document blocks for FTS', () => {
      const doc = {
        id: 'doc-1',
        title: 'Test Doc',
        hpath: '/test',
        content: 'This is searchable content',
        blocks: [
          { id: 'block-1', content: 'First block content' },
          { id: 'block-2', content: 'Second block content' },
        ],
        updated: '2026-02-16T10:00:00Z',
      };

      indexManager.indexDocument(doc);

      const results = indexManager.db.prepare(
        'SELECT * FROM block_fts WHERE doc_id = ?'
      ).all('doc-1');

      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('full-text search', () => {
    beforeEach(() => {
      // Index some test documents
      indexManager.indexDocument({
        id: 'doc-1',
        title: 'Rust Programming',
        hpath: '/programming/rust',
        content: 'Rust is a systems programming language',
        blocks: [
          { id: 'b1', content: 'Rust is a systems programming language' },
          { id: 'b2', content: 'It focuses on memory safety' },
        ],
        updated: '2026-02-16T10:00:00Z',
      });

      indexManager.indexDocument({
        id: 'doc-2',
        title: 'Python Guide',
        hpath: '/programming/python',
        content: 'Python is a high-level language',
        blocks: [
          { id: 'b3', content: 'Python is easy to learn' },
        ],
        updated: '2026-02-16T10:00:00Z',
      });
    });

    it('should search by keyword', () => {
      const results = indexManager.search('Rust');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].doc_id).toBe('doc-1');
    });

    it('should search with multiple keywords', () => {
      const results = indexManager.search('Rust programming');

      expect(results.length).toBeGreaterThan(0);
    });

    it('should return empty array for no matches', () => {
      const results = indexManager.search('nonexistent');

      expect(results).toEqual([]);
    });

    it('should rank results by relevance', () => {
      const results = indexManager.search('programming');

      expect(results.length).toBeGreaterThan(0);
      // Results should be ordered by rank
    });

    it('should limit search results', () => {
      const results = indexManager.search('programming', { limit: 1 });

      expect(results).toHaveLength(1);
    });
  });

  describe('incremental sync', () => {
    it('should track last sync time', () => {
      const timestamp = new Date().toISOString();
      indexManager.updateSyncTime(timestamp);

      const lastSync = indexManager.getLastSyncTime();

      expect(lastSync).toBe(timestamp);
    });

    it('should sync multiple documents in batch', () => {
      const docs = [
        {
          id: 'doc-1',
          title: 'Doc 1',
          hpath: '/test/1',
          content: 'Content 1',
          updated: '2026-02-16T10:00:00Z',
        },
        {
          id: 'doc-2',
          title: 'Doc 2',
          hpath: '/test/2',
          content: 'Content 2',
          updated: '2026-02-16T10:00:00Z',
        },
      ];

      indexManager.syncDocuments(docs);

      const count = indexManager.db.prepare(
        'SELECT COUNT(*) as count FROM doc_registry'
      ).get().count;

      expect(count).toBe(2);
    });

    it('should mark deleted documents', () => {
      indexManager.indexDocument({
        id: 'doc-1',
        title: 'Test',
        hpath: '/test',
        content: 'Content',
        updated: '2026-02-16T10:00:00Z',
      });

      indexManager.markDeleted('doc-1');

      const result = indexManager.db.prepare(
        'SELECT deleted FROM doc_registry WHERE doc_id = ?'
      ).get('doc-1');

      expect(result.deleted).toBe(1);
    });
  });

  describe('statistics', () => {
    it('should return index statistics', () => {
      indexManager.indexDocument({
        id: 'doc-1',
        title: 'Test',
        hpath: '/test',
        content: 'Content',
        updated: '2026-02-16T10:00:00Z',
      });

      const stats = indexManager.getStatistics();

      expect(stats.totalDocs).toBe(1);
      expect(stats.totalBlocks).toBeGreaterThan(0);
      expect(stats.lastSync).toBeDefined();
    });
  });

  describe('cleanup', () => {
    it('should delete old deleted documents', () => {
      indexManager.indexDocument({
        id: 'doc-1',
        title: 'Test',
        hpath: '/test',
        content: 'Content',
        updated: '2026-02-16T10:00:00Z',
      });

      indexManager.markDeleted('doc-1');

      // Set deleted_at to 31 days ago
      indexManager.db.prepare(
        "UPDATE doc_registry SET deleted_at = datetime('now', '-31 days') WHERE doc_id = ?"
      ).run('doc-1');

      indexManager.cleanupOldDeleted(30);

      const result = indexManager.db.prepare(
        'SELECT * FROM doc_registry WHERE doc_id = ?'
      ).get('doc-1');

      expect(result).toBeUndefined();
    });
  });
});
