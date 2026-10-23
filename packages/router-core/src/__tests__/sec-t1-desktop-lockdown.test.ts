import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveCliExecutable,
  tryResolveCliExecutable,
  getDeniedCliDirs,
  ANTIGRAVITY_CLI_BINARIES,
  ACP_CLI_BINARIES
} from '../cli-exec.js';
import {
  isTrustedLocalOrigin,
  isAllowedLocalHost,
  desktopTokenEquals,
  extractDesktopToken,
  getOrCreateDesktopToken,
  DESKTOP_TOKEN_HEADER
} from '../local-request-guard.js';
import { getAppPaths } from '../paths.js';

// Security Tier 1 regression tests (audit C-1 / M-1 / M-2 / H-12 / H-13).
// Pre-fix, none of these units existed: the desktop server had no token,
// no Origin rejection, and no Host check, and router-core spawned the
// config-supplied cliPath verbatim (antigravity) or after a basename-only
// check (ACP). These tests pin the new rejection behavior.

describe('resolveCliExecutable', () => {
  let scratchDir: string;
  let fakeAgy: string;

  beforeAll(() => {
    // A writable location that is NOT on the denied list (package tree),
    // standing in for a legitimate install dir like ~/.local/bin.
    scratchDir = fs.mkdtempSync(path.join(process.cwd(), '.sec-t1-scratch-'));
    fakeAgy = path.join(scratchDir, 'agy');
    fs.writeFileSync(fakeAgy, '#!/bin/sh\necho fake\n', { mode: 0o755 });
  });

  afterAll(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it('resolves an allowlisted executable outside denied dirs', () => {
    const resolved = resolveCliExecutable(fakeAgy, {
      allowedBasenames: ANTIGRAVITY_CLI_BINARIES
    });
    expect(resolved).toBe(fs.realpathSync(fakeAgy));
  });

  it('resolves a bare name via PATH', () => {
    const resolved = resolveCliExecutable('agy', {
      allowedBasenames: ANTIGRAVITY_CLI_BINARIES,
      env: { ...process.env, PATH: scratchDir }
    });
    expect(resolved).toBe(fs.realpathSync(fakeAgy));
  });

  it('rejects a basename that is not allowlisted, even at a safe location', () => {
    const evil = path.join(scratchDir, 'evil');
    fs.writeFileSync(evil, '#!/bin/sh\necho pwned\n', { mode: 0o755 });
    expect(() =>
      resolveCliExecutable(evil, { allowedBasenames: ANTIGRAVITY_CLI_BINARIES })
    ).toThrow(/not an authorized CLI binary/);
    expect(() =>
      resolveCliExecutable('sh', { allowedBasenames: ACP_CLI_BINARIES })
    ).toThrow(/not an authorized CLI binary/);
  });

  it('rejects an allowlisted name under a world-writable dir (/tmp) — the C-1/M-1 shape', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-t1-dropped-'));
    const tmpAgy = path.join(tmpDir, 'agy');
    fs.writeFileSync(tmpAgy, '#!/bin/sh\necho pwned\n', { mode: 0o755 });
    const tmpGoose = path.join(tmpDir, 'goose');
    fs.writeFileSync(tmpGoose, '#!/bin/sh\necho pwned\n', { mode: 0o755 });
    try {
      expect(() =>
        resolveCliExecutable(tmpAgy, { allowedBasenames: ANTIGRAVITY_CLI_BINARIES })
      ).toThrow(/world-writable or config-controlled/);
      expect(() =>
        resolveCliExecutable(tmpGoose, { allowedBasenames: ACP_CLI_BINARIES })
      ).toThrow(/world-writable or config-controlled/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects an allowlisted name dropped into the eluvix config dir', () => {
    const { configDir } = getAppPaths('eluvix');
    fs.mkdirSync(configDir, { recursive: true });
    const dropped = path.join(configDir, 'goose');
    fs.writeFileSync(dropped, '#!/bin/sh\necho pwned\n', { mode: 0o755 });
    try {
      expect(() =>
        resolveCliExecutable(dropped, { allowedBasenames: ACP_CLI_BINARIES })
      ).toThrow(/world-writable or config-controlled/);
    } finally {
      fs.rmSync(dropped, { force: true });
    }
  });

  it('rejects a symlink that launders a denied location', () => {
    const tmpTarget = path.join(os.tmpdir(), `agy-target-${process.pid}`);
    fs.writeFileSync(tmpTarget, '#!/bin/sh\necho pwned\n', { mode: 0o755 });
    const link = path.join(scratchDir, 'antigravity');
    try {
      fs.symlinkSync(tmpTarget, link);
      expect(() =>
        resolveCliExecutable(link, { allowedBasenames: ANTIGRAVITY_CLI_BINARIES })
      ).toThrow(/world-writable or config-controlled/);
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(tmpTarget, { force: true });
    }
  });

  it('rejects missing and non-executable files', () => {
    expect(() =>
      resolveCliExecutable(path.join(scratchDir, 'agy-missing'), {
        allowedBasenames: [...ANTIGRAVITY_CLI_BINARIES, 'agy-missing']
      })
    ).toThrow(/does not exist|not found/);

    const notExec = path.join(scratchDir, 'antigravity');
    fs.writeFileSync(notExec, 'not a binary', { mode: 0o644 });
    expect(() =>
      resolveCliExecutable(notExec, { allowedBasenames: ANTIGRAVITY_CLI_BINARIES })
    ).toThrow(/not executable/);
  });

  it('denied-dir list covers tmp and the app state dirs', () => {
    const { configDir, dataDir } = getAppPaths('eluvix');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    const denied = getDeniedCliDirs();
    expect(denied).toContain(fs.realpathSync(os.tmpdir()));
    expect(denied).toContain(fs.realpathSync(configDir));
    expect(denied).toContain(fs.realpathSync(dataDir));
  });

  it('tryResolveCliExecutable returns null instead of throwing', () => {
    expect(
      tryResolveCliExecutable('/tmp/agy', { allowedBasenames: ANTIGRAVITY_CLI_BINARIES })
    ).toBeNull();
    expect(
      tryResolveCliExecutable(fakeAgy, { allowedBasenames: ANTIGRAVITY_CLI_BINARIES })
    ).toBe(fs.realpathSync(fakeAgy));
  });
});

describe('isTrustedLocalOrigin', () => {
  it('accepts local origins incl. the desktop renderer schemes', () => {
    for (const origin of [
      'http://localhost:3001',
      'https://127.0.0.1:3001',
      'http://[::1]:3001',
      'https://eluvix.local',
      'file://',
      'app://.',
      'vscode-webview://abc'
    ]) {
      expect(isTrustedLocalOrigin(origin), origin).toBe(true);
    }
  });

  it('rejects remote and suffix-spoofed origins', () => {
    for (const origin of [
      'https://evil.example',
      'http://attacker.local',
      'http://localhost.evil.example',
      'http://127.0.0.1.evil.example',
      'null',
      'not a url',
      ''
    ]) {
      expect(isTrustedLocalOrigin(origin), origin).toBe(false);
    }
  });
});

describe('isAllowedLocalHost', () => {
  it('accepts loopback and eluvix.local hosts, with or without ports', () => {
    for (const host of [
      'localhost',
      'localhost:3001',
      '127.0.0.1',
      '127.0.0.1:3001',
      '[::1]:3001',
      '::1',
      'eluvix.local',
      'eluvix.local:3001',
      'LOCALHOST:3001'
    ]) {
      expect(isAllowedLocalHost(host), host).toBe(true);
    }
  });

  it('rejects rebinding and lookalike hosts', () => {
    for (const host of [
      'evil.example',
      'evil.example:3001',
      'attacker.local',
      '127.0.0.1.evil.example',
      'localhost.evil.example',
      'eluvix.local.evil.example',
      '',
      undefined,
      null
    ]) {
      expect(isAllowedLocalHost(host as string), String(host)).toBe(false);
    }
  });
});

describe('desktop token', () => {
  it('compares in constant time semantics: exact match only', () => {
    expect(desktopTokenEquals('abc123', 'abc123')).toBe(true);
    expect(desktopTokenEquals('abc123', 'abc124')).toBe(false);
    expect(desktopTokenEquals('abc123', 'abc1234')).toBe(false);
    expect(desktopTokenEquals('', 'abc123')).toBe(false);
    expect(desktopTokenEquals('abc123', '')).toBe(false);
  });

  it('extracts from the dedicated header or a Bearer credential', () => {
    expect(extractDesktopToken({ [DESKTOP_TOKEN_HEADER]: 'tok1' })).toBe('tok1');
    expect(extractDesktopToken({ authorization: 'Bearer tok2' })).toBe('tok2');
    expect(
      extractDesktopToken({ [DESKTOP_TOKEN_HEADER]: 'tok1', authorization: 'Bearer tok2' })
    ).toBe('tok1');
    expect(extractDesktopToken({})).toBeNull();
    expect(extractDesktopToken({ authorization: 'Basic abc' })).toBeNull();
  });

  it('persists a 0o600 token file and reuses it across calls', () => {
    const first = getOrCreateDesktopToken();
    expect(first.isNew).toBe(true);
    expect(first.token.length).toBeGreaterThanOrEqual(32);
    const mode = fs.statSync(first.tokenFile).mode & 0o777;
    expect(mode).toBe(0o600);

    const second = getOrCreateDesktopToken();
    expect(second.isNew).toBe(false);
    expect(second.token).toBe(first.token);
    expect(second.tokenFile).toBe(first.tokenFile);
  });
});
