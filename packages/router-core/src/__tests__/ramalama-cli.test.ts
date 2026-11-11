import { describe, it, expect } from 'vitest';
import {
  parseRamalamaListJson,
  parseRamalamaContainersJson,
  inspectRamalamaCli,
} from '../cli-exec.js';

describe('RamaLama CLI Inspection & JSON Parsers', () => {
  it('parses ramalama list --json output in both array and object formats', () => {
    const rawArray = JSON.stringify([
      {
        name: 'oci://quay.io/ramalama/granite-code:8b',
        id: 'sha256:abc123',
        size: 4831838208,
        modified: '2026-11-01T12:00:00Z',
      },
      {
        model: 'ollama://llama3.2:3b',
        size: '2.1 GB',
      },
    ]);

    const models = parseRamalamaListJson(rawArray);
    expect(models).toHaveLength(2);
    expect(models[0]).toEqual({
      name: 'oci://quay.io/ramalama/granite-code:8b',
      id: 'sha256:abc123',
      size: 4831838208,
      modified: '2026-11-01T12:00:00Z',
    });
    expect(models[1]).toEqual({
      name: 'ollama://llama3.2:3b',
      size: '2.1 GB',
    });

    expect(parseRamalamaListJson('')).toEqual([]);
    expect(parseRamalamaListJson('not-valid-json')).toEqual([]);
  });

  it('parses ramalama containers --json output from Podman/Docker JSON', () => {
    const rawContainers = JSON.stringify([
      {
        Names: ['ramalama-granite-8080'],
        Image: 'quay.io/ramalama/cuda:latest',
        Status: 'Up 14 minutes',
        Ports: [{ host_port: 8080, container_port: 8080 }],
      },
    ]);

    const containers = parseRamalamaContainersJson(rawContainers);
    expect(containers).toEqual([
      {
        name: 'ramalama-granite-8080',
        image: 'quay.io/ramalama/cuda:latest',
        status: 'Up 14 minutes',
        ports: '8080:8080',
      },
    ]);
  });

  it('gracefully reports installed: false when ramalama binary is not on PATH', async () => {
    const res = await inspectRamalamaCli({
      env: { PATH: '/nonexistent-dir-eluvix-test' },
      timeoutMs: 1000,
    });
    expect(res.installed).toBe(false);
    expect(res.models).toEqual([]);
    expect(res.containers).toEqual([]);
  });
});
