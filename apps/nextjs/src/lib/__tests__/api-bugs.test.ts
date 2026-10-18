import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import { evaluateMathExpression, isBlockedHost, normalizeProbeUrl, isValidContainerName } from '../api-helpers';
import { getConfigPath, saveConfig, validateConfig, ConfigValidationError } from '../router';
import { Eluvix } from '@eluvix/router-core';

describe('API Bug Fixes Regression Suite', () => {
  let testDir: string;
  const originalConfig = process.env.XDG_CONFIG_HOME;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `eluvix-config-vitest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.XDG_CONFIG_HOME = path.join(testDir, 'config');
  });

  afterEach(() => {
    if (originalConfig !== undefined) {
      process.env.XDG_CONFIG_HOME = originalConfig;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
    try {
      if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  describe('Tool Evaluator: evaluateMathExpression', () => {
    it('evaluates basic arithmetic and respect operator precedence', () => {
      expect(evaluateMathExpression('2 + 2 * 4')).toBe(10);
      expect(evaluateMathExpression('(2 + 2) * 4')).toBe(16);
      expect(evaluateMathExpression('100 - 25 * 2')).toBe(50);
      expect(evaluateMathExpression('10 / 2 + 3')).toBe(8);
      expect(evaluateMathExpression('10 % 3')).toBe(1);
    });

    it('handles unary operators and floating point decimals', () => {
      expect(evaluateMathExpression('-5 + 10')).toBe(5);
      expect(evaluateMathExpression('2 * -3')).toBe(-6);
      expect(evaluateMathExpression('1.5 * 2')).toBe(3);
      expect(evaluateMathExpression('0.1 + 0.2')).toBeCloseTo(0.3);
    });

    it('throws errors on division by zero and modulo by zero', () => {
      expect(() => evaluateMathExpression('10 / 0')).toThrow(/Division by zero/);
      expect(() => evaluateMathExpression('10 % 0')).toThrow(/Division by zero/);
    });

    it('rejects malicious characters, code execution attempts, and syntax errors', () => {
      expect(() => evaluateMathExpression('process.exit()')).toThrow(/Invalid character/);
      expect(() => evaluateMathExpression('console.log(1)')).toThrow(/Invalid character/);
      expect(() => evaluateMathExpression('2++')).toThrow(/Unexpected end of expression/);
      expect(() => evaluateMathExpression('(2 + 3')).toThrow(/Mismatched parentheses/);
      expect(() => evaluateMathExpression('')).toThrow(/Expression must be a non-empty string/);
      expect(() => evaluateMathExpression('   ')).toThrow(/Expression cannot be empty/);
      expect(() => evaluateMathExpression('1.2.3')).toThrow(/multiple decimal points/);
    });
  });

  describe('SSRF Protection: isBlockedHost', () => {
    it('blocks loopback and local hostnames', () => {
      expect(isBlockedHost('localhost')).toBe(true);
      expect(isBlockedHost('127.0.0.1')).toBe(true);
      expect(isBlockedHost('127.0.1.1')).toBe(true);
      expect(isBlockedHost('0.0.0.0')).toBe(true);
      expect(isBlockedHost('::1')).toBe(true);
      expect(isBlockedHost('[::1]')).toBe(true);
      expect(isBlockedHost('my-app.local')).toBe(true);
      expect(isBlockedHost('test.localhost')).toBe(true);
      expect(isBlockedHost('internal.service.internal')).toBe(true);
    });

    it('blocks cloud metadata service (169.254.169.254) and link-local addresses', () => {
      expect(isBlockedHost('169.254.169.254')).toBe(true);
      expect(isBlockedHost('169.254.1.1')).toBe(true);
      expect(isBlockedHost('fe80::1')).toBe(true);
      expect(isBlockedHost('::ffff:169.254.169.254')).toBe(true);
      expect(isBlockedHost('::ffff:127.0.0.1')).toBe(true);
      expect(isBlockedHost('100.64.0.1')).toBe(true);
      expect(isBlockedHost('198.18.0.1')).toBe(true);
    });

    it('blocks RFC 1918 private IPv4 subnets', () => {
      expect(isBlockedHost('10.0.0.1')).toBe(true);
      expect(isBlockedHost('10.255.255.254')).toBe(true);
      expect(isBlockedHost('172.16.0.1')).toBe(true);
      expect(isBlockedHost('172.31.255.255')).toBe(true);
      expect(isBlockedHost('192.168.1.1')).toBe(true);
      expect(isBlockedHost('192.168.0.100')).toBe(true);
    });

    it('allows external public hosts', () => {
      expect(isBlockedHost('example.com')).toBe(false);
      expect(isBlockedHost('api.openai.com')).toBe(false);
      expect(isBlockedHost('93.184.216.34')).toBe(false);
      expect(isBlockedHost('8.8.8.8')).toBe(false);
    });
  });

  describe('Observability: normalizeProbeUrl', () => {
    it('normalizes Ollama endpoints with and without trailing slash', () => {
      expect(normalizeProbeUrl('http://localhost:11434', 'ollama')).toBe('http://localhost:11434/api/tags');
      expect(normalizeProbeUrl('http://localhost:11434/', 'ollama')).toBe('http://localhost:11434/api/tags');
    });

    it('normalizes OpenAI/vLLM endpoints without creating /v1/v1/models', () => {
      expect(normalizeProbeUrl('http://localhost:8000', 'vllm')).toBe('http://localhost:8000/v1/models');
      expect(normalizeProbeUrl('http://localhost:8000/', 'vllm')).toBe('http://localhost:8000/v1/models');
      expect(normalizeProbeUrl('http://localhost:8082/v1', 'openai-compatible')).toBe('http://localhost:8082/v1/models');
      expect(normalizeProbeUrl('http://localhost:13305', 'lemonade')).toBe('http://localhost:13305/v1/models');
      expect(normalizeProbeUrl('http://localhost:8080', 'switchyard')).toBe('http://localhost:8080/v1/models');
      expect(normalizeProbeUrl('http://localhost:8080/', 'switchyard')).toBe('http://localhost:8080/v1/models');
    });
  });

  describe('Docker Logs: isValidContainerName', () => {
    it('accepts known container service names', () => {
      expect(isValidContainerName('switchyard')).toBe(true);
      expect(isValidContainerName('vllm-sr')).toBe(true);
      expect(isValidContainerName('ollama')).toBe(true);
      expect(isValidContainerName('vllm')).toBe(true);
      expect(isValidContainerName('agent-router')).toBe(true);
      expect(isValidContainerName('agentgateway')).toBe(true);
      expect(isValidContainerName('lemonade')).toBe(true);
      expect(isValidContainerName('router')).toBe(true);
    });

    it('rejects flag injection and invalid or unallowlisted characters/names', () => {
      expect(isValidContainerName('--all')).toBe(false);
      expect(isValidContainerName('-it')).toBe(false);
      expect(isValidContainerName('; rm -rf /')).toBe(false);
      expect(isValidContainerName('vllm && echo pwned')).toBe(false);
      expect(isValidContainerName('container with spaces')).toBe(false);
      expect(isValidContainerName('unauthorized-database')).toBe(false);
      expect(isValidContainerName('redis')).toBe(false);
      expect(isValidContainerName('')).toBe(false);
    });
  });

  describe('Configuration & Models Validation', () => {

    it('resolves config path dynamically against XDG_CONFIG_HOME and writes atomically', () => {
      const cfgPath = getConfigPath();
      expect(cfgPath).toContain(path.join(testDir, 'config', 'eluvix', 'config.json'));

      const newConfig = {
        strategy: 'priority' as const,
        upstreams: [
          {
            id: 'test-node',
            name: 'Test Node',
            type: 'openai-compatible' as const,
            endpoint: 'http://localhost:9000',
            priority: 1,
            models: ['gpt-4o', '*']
          }
        ]
      };

      saveConfig(newConfig);
      expect(fs.existsSync(cfgPath)).toBe(true);
      const readBack = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      expect(readBack.upstreams[0].id).toBe('test-node');
    });

    it('rejects upstreams missing the models array in validateConfig', () => {
      const invalid = {
        upstreams: [
          {
            id: 'bad-node',
            name: 'Bad Node',
            type: 'vllm',
            endpoint: 'http://localhost:8000'
            // missing models!
          }
        ]
      };
      expect(() => validateConfig(invalid)).toThrowError(ConfigValidationError);
    });

    it('router-core matchesModel safely returns false when upstream models is not an array', () => {
      const router = new Eluvix({
        upstreams: []
      });

      const badUpstream: any = {
        id: 'corrupt',
        name: 'Corrupt',
        type: 'vllm',
        endpoint: 'http://localhost:8000'
        // models is undefined
      };

      expect(router.matchesModel(badUpstream, 'llama3')).toBe(false);
      expect(router.matchesModel(badUpstream, 'auto')).toBe(false);
    });

    it('router-core matchesModel prevents antigravity from capturing arbitrary models via wildcard', () => {
      const router = new Eluvix({
        upstreams: []
      });

      const agyUpstream: any = {
        id: 'antigravity-agent',
        name: 'Antigravity',
        type: 'antigravity',
        endpoint: 'cli://agy',
        models: ['gemini-4-argon', 'gemini-3.8-flash', 'claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-oss-120b', '*']
      };

      // Supported models and auto must match
      expect(router.matchesModel(agyUpstream, 'auto')).toBe(true);
      expect(router.matchesModel(agyUpstream, 'gemini-4-argon')).toBe(true);
      expect(router.matchesModel(agyUpstream, 'claude-opus-5-5')).toBe(true);
      expect(router.matchesModel(agyUpstream, 'gpt-oss-120b')).toBe(true);

      // Foreign or nonexistent models must NOT be hijacked by antigravity via '*'
      expect(router.matchesModel(agyUpstream, 'nonexistent-model-xyz')).toBe(false);
      expect(router.matchesModel(agyUpstream, 'llama3')).toBe(false);
      expect(router.matchesModel(agyUpstream, 'deepseek-ai/deepseek-coder-6.7b')).toBe(false);
    });
  });

  describe('Chat Completions API Validation', () => {
    it('rejects missing or empty messages array with HTTP 400', async () => {
      const { POST } = await import('../../app/api/v1/chat/completions/route');

      // Empty body object {}
      const res1 = await POST(new Request('http://localhost/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      }));
      expect(res1.status).toBe(400);
      const json1 = await res1.json();
      expect(json1.error.code).toBe('missing_required_parameter');

      // Empty messages array []
      const res2 = await POST(new Request('http://localhost/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [] })
      }));
      expect(res2.status).toBe(400);
      const json2 = await res2.json();
      expect(json2.error.code).toBe('missing_required_parameter');

      // Invalid JSON
      const res3 = await POST(new Request('http://localhost/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid-json{'
      }));
      expect(res3.status).toBe(400);
      const json3 = await res3.json();
      expect(json3.error.code).toBe('invalid_json');
    });

    it('returns 404 for model_not_found when model cannot be routed', async () => {
      const { saveConfig } = await import('../router');
      saveConfig({
        strategy: 'priority',
        upstreams: [
          {
            id: 'local-node',
            name: 'Local Node',
            type: 'ollama',
            endpoint: 'http://localhost:11434',
            priority: 1,
            models: ['llama3']
          }
        ]
      });

      const { POST } = await import('../../app/api/v1/chat/completions/route');

      const res = await POST(new Request('http://localhost/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'this-model-does-not-exist-anywhere-999',
          messages: [{ role: 'user', content: 'test' }]
        })
      }));
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe('model_not_found');
    });
  });

  describe('Database Multimodal Chat Logging', () => {
    it('safely serializes object/array multimodal content in saveChatMessage without throwing', async () => {
      const { saveChatMessage, getChatHistory } = await import('@eluvix/router-core');

      const sessionId = `test-multimodal-${Date.now()}`;
      const multimodalContent = [
        { type: 'text', text: 'Analyze this image' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo...' } }
      ];

      expect(() => {
        saveChatMessage(sessionId, 'user', multimodalContent);
      }).not.toThrow();

      const history = getChatHistory(sessionId);
      expect(history.length).toBe(1);
      expect(history[0].role).toBe('user');
      expect(typeof history[0].content).toBe('string');
      expect(history[0].content).toContain('Analyze this image');
    });
  });
});

