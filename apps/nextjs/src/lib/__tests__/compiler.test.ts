import { describe, it, expect } from 'vitest';
import { compileGraph } from '../orchestration/compiler';
import { Node } from '@xyflow/react';

describe('Eluvix Canvas Compiler', () => {
  it('should compile privacy guard node with custom regex, whitelist, and hash redaction', () => {
    const nodes: Node[] = [
      {
        id: 'pg-1',
        type: 'privacyGuardNode',
        position: { x: 0, y: 0 },
        data: {
          action: 'anonymize',
          redactionStyle: 'hash',
          whitelist: ['internal.corp', 'dev-token'],
          detectPii: { apiKey: true, ssn: false },
          customPatterns: [{ name: 'EmployeeID', pattern: 'EMP-\\d{6}' }],
          auditLogging: true,
        },
      },
    ];
    const result = compileGraph(nodes, []);
    expect(result.privacyGuardSetup).toContain('redactionStyle: "hash"');
    expect(result.privacyGuardSetup).toContain('"name":"EmployeeID"');
    expect(result.privacyGuardSetup).toContain('EMP-');
    expect(result.eluvixJson).toContain('"redactionStyle": "hash"');
    expect(result.eluvixJson).toContain('"auditLogging": true');
  });

  it('should compile semantic guard node with threat vectors and banned phrases', () => {
    const nodes: Node[] = [
      {
        id: 'sg-1',
        type: 'semanticGuardNode',
        position: { x: 0, y: 0 },
        data: {
          routeName: 'strict-firewall',
          encoder: 'deberta-v3-injection',
          threshold: 0.92,
          enforcementAction: 'divert',
          threatVectors: { instructionOverride: true, danJailbreak: true },
          bannedPhrases: ['secret_token_override', 'bypass_policy'],
        },
      },
    ];
    const result = compileGraph(nodes, []);
    expect(result.semanticRouterSetup).toContain('strict-firewall');
    expect(result.semanticRouterSetup).toContain('deberta-v3-injection');
    expect(result.semanticRouterSetup).toContain('secret_token_override');
    expect(result.eluvixJson).toContain('"action": "divert"');
  });

  it('should compile model gateway with caching and rate limits', () => {
    const nodes: Node[] = [
      {
        id: 'mg-1',
        type: 'modelGatewayNode',
        position: { x: 0, y: 0 },
        data: {
          primaryModel: 'llama3:70b',
          fallbackStrategy: 'same-tier',
          cacheEnabled: true,
          cacheTtlSeconds: 7200,
          cacheSimilarityThreshold: 0.98,
          rateLimitRpm: 120,
          rateLimitTpm: 500000,
          systemPromptPrepend: 'You are an internal sovereign assistant.',
        },
      },
    ];
    const result = compileGraph(nodes, []);
    expect(result.bifrostYaml).toContain('caching:');
    expect(result.bifrostYaml).toContain('ttl_seconds: 7200');
    expect(result.bifrostYaml).toContain('rate_limits:');
    expect(result.bifrostYaml).toContain('max_rpm: 120');
    expect(result.eluvixJson).toContain('"primaryModel": "llama3:70b"');
  });

  it('should compile task router with classifier engine and routing preference', () => {
    const nodes: Node[] = [
      {
        id: 'tr-1',
        type: 'taskRouterNode',
        position: { x: 0, y: 0 },
        data: {
          classificationEngine: 'fastembed',
          preference: 'cost',
          confidenceThreshold: 0.88,
        },
      },
    ];
    const result = compileGraph(nodes, []);
    expect(result.agentRouterJson).toContain('"classificationEngine": "fastembed"');
    expect(result.agentRouterJson).toContain('"preference": "cost"');
    expect(result.agentRouterJson).toContain('"confidenceThreshold": 0.88');
  });

  it('should compile agent gateway with tool filtering', () => {
    const nodes: Node[] = [
      {
        id: 'ag-1',
        type: 'agentGatewayNode',
        position: { x: 0, y: 0 },
        data: {
          accessPolicy: 'restrictive',
          toolFilterMode: 'whitelist',
          toolTimeoutMs: 8000,
          enableNativeTools: false,
          sanitizeToolOutput: true,
        },
      },
    ];
    const result = compileGraph(nodes, []);
    expect(result.agentGatewayJson).toContain('"accessPolicy": "restrictive"');
    expect(result.agentGatewayJson).toContain('"toolFilterMode": "whitelist"');
    expect(result.agentGatewayJson).toContain('"toolTimeoutMs": 8000');
    expect(result.agentGatewayJson).toContain('"sanitizeToolOutput": true');
  });

  it('should compile observability node with collector exporter and pii scrubbing', () => {
    const nodes: Node[] = [
      {
        id: 'obs-1',
        type: 'observabilityNode',
        position: { x: 0, y: 0 },
        data: {
          exporter: 'otlp',
          endpointUrl: 'http://otel-collector:4318/v1/traces',
          projectName: 'eluvix-fintech',
          samplingRate: 75,
          scrubPii: true,
          captureInputs: false,
          latencyAlertMs: 3500,
        },
      },
    ];
    const result = compileGraph(nodes, []);
    expect(result.observabilitySetup).toContain('exporter: "otlp"');
    expect(result.observabilitySetup).toContain('http://otel-collector:4318/v1/traces');
    expect(result.observabilitySetup).toContain('scrubPii: true');
    expect(result.observabilitySetup).toContain('latencyAlertMs: 3500');
  });
});
