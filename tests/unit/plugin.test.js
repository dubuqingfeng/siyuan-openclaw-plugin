import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the SiYuan client
vi.mock('../../src/clients/siyuan-client.js', () => ({
  SiYuanClient: vi.fn().mockImplementation(() => ({
    healthCheck: vi.fn().mockResolvedValue({ available: true, version: '2.8.0' }),
    getUpdatedBlocks: vi.fn().mockResolvedValue([]),
    listNotebooks: vi.fn().mockResolvedValue([
      { id: 'nb1', name: '日记' },
    ]),
    getBlockKramdown: vi.fn().mockResolvedValue({ id: 'd1', kramdown: '# T' }),
  })),
}));

const { register } = await import('../../index.js');

describe('plugin lifecycle', () => {
  let mockApi;

  beforeEach(() => {
    mockApi = {
      on: vi.fn(),
      config: {
        siyuan: {
          apiUrl: 'http://127.0.0.1:6806',
          apiToken: 'test-token',
        },
      },
    };
  });

  describe('register', () => {
    it('should register plugin with api', async () => {
      await register(mockApi);

      expect(mockApi.on).toHaveBeenCalled();
    });

    it('should register before_agent_start hook', async () => {
      await register(mockApi);

      const calls = mockApi.on.mock.calls;
      const beforeStartCall = calls.find(call => call[0] === 'before_agent_start');

      expect(beforeStartCall).toBeDefined();
      expect(typeof beforeStartCall[1]).toBe('function');
    });

    it('should register agent_end hook', async () => {
      await register(mockApi);

      const calls = mockApi.on.mock.calls;
      const agentEndCall = calls.find(call => call[0] === 'agent_end');

      expect(agentEndCall).toBeDefined();
      expect(typeof agentEndCall[1]).toBe('function');
    });

    it('should register command:new hook', async () => {
      await register(mockApi);

      const calls = mockApi.on.mock.calls;
      const commandNewCall = calls.find(call => call[0] === 'command:new');

      expect(commandNewCall).toBeDefined();
      expect(typeof commandNewCall[1]).toBe('function');
    });

    it('should perform health check during registration', async () => {
      const result = await register(mockApi);
      await result.ready;

      expect(result.ready).toBeDefined();
    });

    it('should handle siyuan unavailable gracefully', async () => {
      const { SiYuanClient } = await import('../../src/clients/siyuan-client.js');
      SiYuanClient.mockImplementationOnce(() => ({
        healthCheck: vi.fn().mockResolvedValue({ available: false }),
      }));

      const result = await register(mockApi);
      await result.ready;

      expect(result.ready).toBeDefined();
    });
  });

  describe('lifecycle hooks', () => {
    it('should handle before_agent_start event', async () => {
      await register(mockApi);

      const beforeStartHook = mockApi.on.mock.calls
        .find(call => call[0] === 'before_agent_start')[1];

      const event = {
        prompt: 'Tell me about Rust project',
        context: {},
      };

      const result = await beforeStartHook(event);

      expect(result).toBeDefined();
    });

    it('should inject linkedDoc even when recall.enabled is false', async () => {
      mockApi.config.recall = {
        enabled: false,
      };
      // Ensure test is not affected by any user config file allowlists.
      mockApi.config.linkedDoc = { enabled: true, hostKeywords: [], maxCount: 3 };

      await register(mockApi);

      const beforeStartHook = mockApi.on.mock.calls
        .find(call => call[0] === 'before_agent_start')[1];

      const event = {
        // short prompt on purpose (bypass minPromptLength via linkedDoc)
        prompt: 'http://127.0.0.1:9081?id=20220802180638-lhtbfty',
        context: {},
      };

      const result = await beforeStartHook(event);

      expect(result).toBeDefined();
      expect(result.prependContext || '').toContain('```markdown');
    });

    it('should handle agent_end event', async () => {
      await register(mockApi);

      const agentEndHook = mockApi.on.mock.calls
        .find(call => call[0] === 'agent_end')[1];

      const event = {
        success: true,
        messages: [
          { role: 'user', content: 'Test question' },
          { role: 'assistant', content: 'Test answer' },
        ],
      };

      await expect(agentEndHook(event)).resolves.not.toThrow();
    });
  });
});
