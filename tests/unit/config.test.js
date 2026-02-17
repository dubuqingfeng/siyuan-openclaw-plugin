import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('configuration management', () => {
  let testConfigDir;
  let testConfigPath;
  let originalCwd;
  let fakeHomeDir;
  let buildConfig;

  beforeEach(async () => {
    originalCwd = process.cwd();
    testConfigDir = join(
      tmpdir(),
      `openclaw-test-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    testConfigPath = join(testConfigDir, 'openclaw.json');
    fakeHomeDir = join(testConfigDir, 'home');
    mkdirSync(testConfigDir, { recursive: true });
    mkdirSync(fakeHomeDir, { recursive: true });

    // Make tests hermetic: never read the developer's real ~/.openclaw files.
    vi.resetModules();
    vi.doMock('os', async () => {
      const actual = await vi.importActual('os');
      return {
        ...actual,
        homedir: () => fakeHomeDir,
      };
    });

    ({ buildConfig } = await import('../../src/clients/config.js'));
  });

  afterEach(() => {
    // Some tests temporarily change cwd to validate default config discovery.
    process.chdir(originalCwd);
    vi.doUnmock('os');
    if (existsSync(testConfigDir)) {
      rmSync(testConfigDir, { recursive: true, force: true });
    }
  });

  describe('buildConfig', () => {
    it('should return default configuration when no config file exists', () => {
      const config = buildConfig('/non-existent/path');

      expect(config).toHaveProperty('siyuan');
      expect(config.siyuan.apiUrl).toBe('http://127.0.0.1:6806');
      expect(config.siyuan.apiToken).toBe('');
    });

    it('should load configuration from file', () => {
      const configData = {
        siyuan: {
          apiUrl: 'http://localhost:7806',
          apiToken: 'test-token-123',
        },
        routing: {
          rules: [
            {
              keywords: ['日记', '今天'],
              target: 'daily_note',
            },
          ],
        },
      };

      writeFileSync(testConfigPath, JSON.stringify(configData, null, 2));

      const config = buildConfig(testConfigPath);

      expect(config.siyuan.apiUrl).toBe('http://localhost:7806');
      expect(config.siyuan.apiToken).toBe('test-token-123');
      expect(config.routing.rules).toHaveLength(1);
      expect(config.routing.rules[0].keywords).toContain('日记');
    });

    it('should load openclaw.config.json from current working directory by default', () => {
      const configData = {
        siyuan: {
          apiUrl: 'http://localhost:6806',
          apiToken: 'cwd-token',
        },
      };

      process.chdir(testConfigDir);
      writeFileSync(join(testConfigDir, 'openclaw.config.json'), JSON.stringify(configData, null, 2));

      const config = buildConfig();

      expect(config.siyuan.apiUrl).toBe('http://localhost:6806');
      expect(config.siyuan.apiToken).toBe('cwd-token');
    });

    it('should prefer openclaw.config.json over openclaw.json in current working directory', () => {
      process.chdir(testConfigDir);
      writeFileSync(join(testConfigDir, 'openclaw.json'), JSON.stringify({
        siyuan: { apiUrl: 'http://localhost:1111', apiToken: 'json-token' },
      }, null, 2));
      writeFileSync(join(testConfigDir, 'openclaw.config.json'), JSON.stringify({
        siyuan: { apiUrl: 'http://localhost:2222', apiToken: 'config-token' },
      }, null, 2));

      const config = buildConfig();

      expect(config.siyuan.apiUrl).toBe('http://localhost:2222');
      expect(config.siyuan.apiToken).toBe('config-token');
    });

    it('should prefer user home config over project-local config', () => {
      // Home config should override project-local config when both exist.
      const homeConfigPath = join(fakeHomeDir, '.openclaw', 'siyuan.config.json');
      mkdirSync(join(fakeHomeDir, '.openclaw'), { recursive: true });
      writeFileSync(
        homeConfigPath,
        JSON.stringify({ siyuan: { apiUrl: 'http://localhost:9999', apiToken: 'home-token' } }, null, 2)
      );

      process.chdir(testConfigDir);
      writeFileSync(
        join(testConfigDir, 'openclaw.config.json'),
        JSON.stringify({ siyuan: { apiUrl: 'http://localhost:2222', apiToken: 'project-token' } }, null, 2)
      );

      const config = buildConfig();

      expect(config.siyuan.apiUrl).toBe('http://localhost:9999');
      expect(config.siyuan.apiToken).toBe('home-token');
    });

    it('should merge with default configuration', () => {
      const partialConfig = {
        siyuan: {
          apiToken: 'partial-token',
        },
      };

      writeFileSync(testConfigPath, JSON.stringify(partialConfig, null, 2));

      const config = buildConfig(testConfigPath);

      expect(config.siyuan.apiUrl).toBe('http://127.0.0.1:6806');
      expect(config.siyuan.apiToken).toBe('partial-token');
      expect(config.routing).toHaveProperty('rules');
    });

    it('should handle invalid json gracefully', () => {
      writeFileSync(testConfigPath, 'invalid json content');

      const config = buildConfig(testConfigPath);

      expect(config.siyuan.apiUrl).toBe('http://127.0.0.1:6806');
    });

    it('should include default routing configuration', () => {
      const config = buildConfig('/non-existent/path');

      expect(config.routing).toHaveProperty('rules');
      expect(Array.isArray(config.routing.rules)).toBe(true);
      expect(config.routing).toHaveProperty('inboxPath');
      expect(config.routing.inboxPath).toBe('/OpenClaw/收件箱');
    });

    it('should include index synchronization settings', () => {
      const config = buildConfig('/non-existent/path');

      expect(config.index).toHaveProperty('syncIntervalMs');
      expect(config.index).toHaveProperty('enabled');
      expect(config.index.enabled).toBe(true);
    });

    it('should include recall settings', () => {
      const config = buildConfig('/non-existent/path');

      expect(config.recall).toHaveProperty('enabled');
      expect(config.recall).toHaveProperty('minPromptLength');
      expect(config.recall).toHaveProperty('maxContextTokens');
      expect(config.recall.enabled).toBe(true);
    });

    it('should include write settings', () => {
      const config = buildConfig('/non-existent/path');

      expect(config.write).toHaveProperty('enabled');
      expect(config.write).toHaveProperty('captureStrategy');
      expect(config.write).toHaveProperty('throttleMs');
      expect(config.write.captureStrategy).toBe('smart');
    });
  });
});
