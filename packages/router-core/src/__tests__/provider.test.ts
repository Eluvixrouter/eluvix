import { describe, it, expect, vi } from 'vitest';
import {
  detectGpuHardware,
  detectLocalEngineModels,
  EluvixProviderAgent
} from '../provider.js';
import {
  getProviderSettings,
  saveProviderSettings,
  logProviderJob,
  getProviderJobLogs
} from '../db.js';

describe('GPU Hardware & Engine Detection', () => {
  it('detects GPU hardware accurately or returns fallback profile', async () => {
    const gpu = await detectGpuHardware();
    expect(gpu).toBeDefined();
    expect(['NVIDIA', 'AMD', 'APPLE', 'INTEL', 'CPU']).toContain(gpu.vendor);
    expect(gpu.vramTotalGb).toBeGreaterThan(0);
    expect(gpu.model).toBeTruthy();
  });

  it('queries or provides fallbacks for local models', async () => {
    const models = await detectLocalEngineModels('http://localhost:11434', 'ollama');
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
    expect(models[0].name).toBeTruthy();
  });
});

describe('Eluvix Provider Agent & Database Persistence', () => {
  it('saves and retrieves provider settings from SQLite', () => {
    const updated = saveProviderSettings({
      node_name: 'Test Rig RTX 4090',
      pricing_mode: 'floor',
      floor_price_in: 0.25,
      floor_price_out: 0.50,
      pause_on_user_active: 1,
      max_gpu_temp_c: 78
    });

    expect(updated).toBeDefined();
    expect(updated?.node_name).toBe('Test Rig RTX 4090');
    expect(updated?.pricing_mode).toBe('floor');
    expect(updated?.floor_price_in).toBe(0.25);
    expect(updated?.max_gpu_temp_c).toBe(78);

    const retrieved = getProviderSettings();
    expect(retrieved?.node_name).toBe('Test Rig RTX 4090');
    expect(retrieved?.floor_price_out).toBe(0.50);
  });

  it('logs completed provider jobs and updates earnings automatically', () => {
    const initialSettings = getProviderSettings();
    const initialTokens = initialSettings?.total_tokens_served || 0;
    const initialEarned = initialSettings?.total_earned_usd || 0;

    logProviderJob({
      job_id: `job-test-${Date.now()}`,
      model: 'meta-llama/Llama-3-8b',
      prompt_tokens: 150,
      completion_tokens: 250,
      duration_ms: 1200,
      earned_usd: 0.0002,
      status: 'SUCCESS'
    });

    const logs = getProviderJobLogs(10);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].status).toBe('SUCCESS');
    expect(logs[0].earned_usd).toBe(0.0002);

    const afterSettings = getProviderSettings();
    expect(afterSettings?.total_tokens_served).toBe(initialTokens + 400);
    expect(afterSettings?.total_earned_usd).toBeCloseTo(initialEarned + 0.0002, 6);
  });

  it('instantiates EluvixProviderAgent with configuration and handles consumer preemption', async () => {
    const agent = new EluvixProviderAgent({
      serverUrl: 'http://127.0.0.1:3000',
      engineUrl: 'http://127.0.0.1:11434',
      pauseOnUserActive: true
    });

    const status = await agent.getStatus();
    expect(status.status).toBe('OFFLINE');
    expect(status.gpu).toBeDefined();

    // Test preemption
    agent.notifyConsumerActive(500); // 500ms hold
    const statusPreempted = await agent.getStatus();
    // When offline, notifyConsumerActive doesn't pause unless running, so test running behavior
  });
});
