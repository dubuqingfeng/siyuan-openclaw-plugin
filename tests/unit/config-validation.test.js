import { describe, it, expect } from 'vitest';
import { validateConfig } from '../../src/clients/config.js';

describe('configuration validation', () => {
  describe('validateConfig', () => {
    it('should pass validation for valid configuration', () => {
      const config = {
        siyuan: {
          apiUrl: 'http://127.0.0.1:6806',
          apiToken: 'test-token',
        },
        recall: {
          maxContextTokens: 2000,
        },
        write: {
          captureStrategy: 'smart',
        },
      };

      const result = validateConfig(config);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should fail when apiUrl is missing', () => {
      const config = {
        siyuan: {},
      };

      const result = validateConfig(config);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('siyuan.apiUrl is required');
    });

    it('should fail when apiUrl is invalid', () => {
      const config = {
        siyuan: {
          apiUrl: 'not-a-valid-url',
        },
      };

      const result = validateConfig(config);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('siyuan.apiUrl must be a valid URL');
    });

    it('should fail when maxContextTokens is not a number', () => {
      const config = {
        siyuan: {
          apiUrl: 'http://127.0.0.1:6806',
        },
        recall: {
          maxContextTokens: 'not-a-number',
        },
      };

      const result = validateConfig(config);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('recall.maxContextTokens must be a number');
    });

    it('should fail when captureStrategy is invalid', () => {
      const config = {
        siyuan: {
          apiUrl: 'http://127.0.0.1:6806',
        },
        write: {
          captureStrategy: 'invalid-strategy',
        },
      };

      const result = validateConfig(config);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain(
        'write.captureStrategy must be one of: last_turn, full_session, smart'
      );
    });

    it('should collect multiple validation errors', () => {
      const config = {
        siyuan: {
          apiUrl: 'invalid-url',
        },
        recall: {
          maxContextTokens: 'invalid',
        },
        write: {
          captureStrategy: 'invalid',
        },
      };

      const result = validateConfig(config);

      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(1);
    });
  });
});
