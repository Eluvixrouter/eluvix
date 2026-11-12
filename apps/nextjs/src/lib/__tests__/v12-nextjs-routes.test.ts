import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createNamedApiKey,
  clearApiKeysCache,
  recordAuditEvent,
  getDb,
} from '@eluvix/router-core';
import { GET as getAudit } from '@/app/api/v1/audit/route';
import { GET as getFiles, POST as postFiles } from '@/app/api/v1/files/route';
import { GET as getFileContent } from '@/app/api/v1/files/[id]/content/route';
import { POST as postBatches } from '@/app/api/v1/batches/route';
import { GET as getBatchById } from '@/app/api/v1/batches/[id]/route';
import { POST as postRerank } from '@/app/api/v1/rerank/route';
import { GET as getPrompts, POST as postPrompts } from '@/app/api/v1/prompts/route';
import { GET as getWebhooks, POST as postWebhooks, DELETE as deleteWebhook } from '@/app/api/v1/webhooks/route';
import { POST as postChatCompletions } from '@/app/api/v1/chat/completions/route';

describe('v1.2 Next.js API Route Handlers (Audit, Batches/Files, Rerank, Prompt Registry, Webhooks, Scoped Keys)', () => {
  let tmpConfigDir: string;
  let tmpDataDir: string;
  let prevXdgConfig: string | undefined;
  let prevXdgData: string | undefined;

  beforeEach(() => {
    prevXdgConfig = process.env.XDG_CONFIG_HOME;
    prevXdgData = process.env.XDG_DATA_HOME;
    tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-v12-next-cfg-'));
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-v12-next-data-'));
    process.env.XDG_CONFIG_HOME = tmpConfigDir;
    process.env.XDG_DATA_HOME = tmpDataDir;
    clearApiKeysCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdgConfig;
    if (prevXdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdgData;
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  });

  it('verifies tamper-evident audit chain via GET /api/v1/audit?verify=1 and detects tampering', async () => {
    const adminKey = createNamedApiKey({
      label: 'Admin Audit Key',
      userId: 'admin-user',
      role: 'admin',
    });

    recordAuditEvent({
      actorId: 'admin-user',
      actorRole: 'admin',
      action: 'security.policy_change',
      resourceType: 'guard',
      details: { strict: true },
    });

    const reqOk = new Request('http://localhost:3588/api/v1/audit?verify=1', {
      headers: { Authorization: `Bearer ${adminKey.key}` },
    });
    const resOk = await getAudit(reqOk);
    expect(resOk.status).toBe(200);
    expect(resOk.headers.get('x-eluvix-audit-chain-valid')).toBe('true');
    const jsonOk = await resOk.json();
    expect(jsonOk.verification.valid).toBe(true);
    expect(jsonOk.data.length).toBeGreaterThanOrEqual(2);

    // Tamper with a row and re-verify
    const db = getDb();
    db.prepare('UPDATE audit_events SET action = ? WHERE seq = 1').run('tampered.action');

    const reqTampered = new Request('http://localhost:3588/api/v1/audit?verify=1', {
      headers: { Authorization: `Bearer ${adminKey.key}` },
    });
    const resTampered = await getAudit(reqTampered);
    expect(resTampered.headers.get('x-eluvix-audit-chain-valid')).toBe('false');
    const jsonTampered = await resTampered.json();
    expect(jsonTampered.verification.valid).toBe(false);
    expect(jsonTampered.verification.firstTamperedSeq).toBe(1);
  });

  it('enforces API key scopes across /api/v1/chat/completions, /api/v1/rerank, /api/v1/prompts, /api/v1/files, /api/v1/batches, and /api/v1/webhooks', async () => {
    const rerankOnlyKey = createNamedApiKey({
      label: 'Rerank Scoped Key',
      userId: 'search-svc',
      role: 'operator',
      scopes: ['rerank'],
    });

    // Using rerankOnlyKey on /api/v1/chat/completions must return 403 insufficient-scope
    const chatReq = new Request('http://localhost:3588/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${rerankOnlyKey.key}`,
      },
      body: JSON.stringify({
        model: 'auto',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    const chatRes = await postChatCompletions(chatReq);
    expect(chatRes.status).toBe(403);

    // Using rerankOnlyKey on /api/v1/rerank succeeds
    const rerankReq = new Request('http://localhost:3588/api/v1/rerank', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${rerankOnlyKey.key}`,
      },
      body: JSON.stringify({
        model: 'auto',
        query: 'NVFP4 microscaling quantization on Blackwell',
        documents: [
          'Bananas and apples are fruits.',
          'NVFP4 microscaling quantization with Walsh-Hadamard rotation runs on Blackwell Tensor Cores.',
        ],
      }),
    });
    const rerankRes = await postRerank(rerankReq);
    expect(rerankRes.status).toBe(200);
    const rerankJson = await rerankRes.json();
    expect(rerankJson.results[0].index).toBe(1);

    // Full-scope operator key exercises Prompt Registry, Batch Files/Jobs, and Webhooks
    const fullKey = createNamedApiKey({
      label: 'Full Operator Key',
      userId: 'alice',
      role: 'operator',
      scopes: ['*'],
    });

    // 1. Prompt Registry
    const promptPostRes = await postPrompts(
      new Request('http://localhost:3588/api/v1/prompts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fullKey.key}`,
        },
        body: JSON.stringify({
          id: 'code-reviewer',
          systemTemplate: 'Review {{lang}} code for security.',
          evalScore: 0.95,
        }),
      })
    );
    expect(promptPostRes.status).toBe(200);
    const promptGetRes = await getPrompts(
      new Request('http://localhost:3588/api/v1/prompts?resolve=code-reviewer@production', {
        headers: { Authorization: `Bearer ${fullKey.key}` },
      })
    );
    expect(promptGetRes.status).toBe(200);
    const resolvedPrompt = await promptGetRes.json();
    expect(resolvedPrompt.version).toBe(1);

    // 2. Batch Files & Jobs
    const fileRes = await postFiles(
      new Request('http://localhost:3588/api/v1/files', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fullKey.key}`,
        },
        body: JSON.stringify({
          filename: 'input.jsonl',
          purpose: 'batch',
          content_jsonl: JSON.stringify({
            custom_id: 'b1',
            method: 'POST',
            url: '/v1/chat/completions',
            body: { model: 'auto', messages: [{ role: 'user', content: 'Hi' }] },
          }),
        }),
      })
    );
    expect(fileRes.status).toBe(200);
    const createdFile = await fileRes.json();

    const listFilesRes = await getFiles(
      new Request('http://localhost:3588/api/v1/files', {
        headers: { Authorization: `Bearer ${fullKey.key}` },
      })
    );
    expect((await listFilesRes.json()).data).toHaveLength(1);

    const contentRes = await getFileContent(
      new Request(`http://localhost:3588/api/v1/files/${createdFile.id}/content`, {
        headers: { Authorization: `Bearer ${fullKey.key}` },
      }),
      { params: { id: createdFile.id } }
    );
    expect(contentRes.status).toBe(200);
    expect(await contentRes.text()).toContain('"custom_id":"b1"');

    const batchRes = await postBatches(
      new Request('http://localhost:3588/api/v1/batches', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fullKey.key}`,
        },
        body: JSON.stringify({
          input_file_id: createdFile.id,
        }),
      })
    );
    expect(batchRes.status).toBe(200);
    const batchJob = await batchRes.json();
    const getBatchRes = await getBatchById(
      new Request(`http://localhost:3588/api/v1/batches/${batchJob.id}`, {
        headers: { Authorization: `Bearer ${fullKey.key}` },
      }),
      { params: { id: batchJob.id } }
    );
    expect(getBatchRes.status).toBe(200);

    // 3. Webhooks CRUD
    const whRes = await postWebhooks(
      new Request('http://localhost:3588/api/v1/webhooks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${fullKey.key}`,
        },
        body: JSON.stringify({
          name: 'Local Slack Hook',
          url: 'http://127.0.0.1:9991/slack',
          provider: 'slack',
          secret: 'whsec_abc',
          events: ['budget.threshold'],
        }),
      })
    );
    expect(whRes.status).toBe(200);
    const createdWh = await whRes.json();

    const listWhRes = await getWebhooks(
      new Request('http://localhost:3588/api/v1/webhooks', {
        headers: { Authorization: `Bearer ${fullKey.key}` },
      })
    );
    expect((await listWhRes.json()).data).toHaveLength(1);

    const delWhRes = await deleteWebhook(
      new Request(`http://localhost:3588/api/v1/webhooks?id=${createdWh.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${fullKey.key}` },
      })
    );
    expect((await delWhRes.json()).deleted).toBe(true);
  });
});
