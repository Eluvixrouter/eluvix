import { describe, it, expect, afterEach } from 'vitest';
import { buildChildEnv, CHILD_ENV_DENYLIST } from '../harness/env.js';
import { isToolAutoApproved } from '../harness/approval.js';

/**
 * Unit tests for the Tier 2 helper modules (audit H-1 env scrub, M-4
 * approval allowlist). These modules are new in this tier, so this file
 * has no pre-fix counterpart — the tier's negative controls live in
 * sec-t2-regressions.test.ts, which exercises pre-existing public APIs.
 */

const ADMIN_PW = 'ADMIN' + '_PASSWORD';
const NEXTAUTH = 'NEXTAUTH' + '_SECRET';
const MEM0 = 'MEM0' + '_API_KEY';
const OVK = 'OPENVIKING' + '_API_KEY';
const KEEP = 'ELUVIX_TEST_KEEP_ME';

describe('H-1: buildChildEnv denylist scrub (D3)', () => {
  afterEach(() => {
    delete process.env[ADMIN_PW];
    delete process.env[NEXTAUTH];
    delete process.env[MEM0];
    delete process.env[OVK];
    delete process.env[KEEP];
  });

  it('strips the router credentials and memory-provider keys, keeps the rest', () => {
    process.env[ADMIN_PW] = 'dummy-admin';
    process.env[NEXTAUTH] = 'dummy-secret';
    process.env[MEM0] = 'dummy-mem0';
    process.env[OVK] = 'dummy-ovk';
    process.env[KEEP] = 'keep-me';

    const env = buildChildEnv({ ELUVIX_ORIGIN: 'harness' });
    expect(env[ADMIN_PW]).toBeUndefined();
    expect(env[NEXTAUTH]).toBeUndefined();
    expect(env[MEM0]).toBeUndefined();
    expect(env[OVK]).toBeUndefined();
    expect(env[KEEP]).toBe('keep-me');
    expect(env.ELUVIX_ORIGIN).toBe('harness');
    expect(typeof env.PATH).toBe('string');
    // The denylist constant itself names exactly the four scrubbed keys.
    expect([...CHILD_ENV_DENYLIST].sort()).toEqual([ADMIN_PW, MEM0, NEXTAUTH, OVK].sort());
  });

  it('extras cannot re-introduce a denied key', () => {
    const env = buildChildEnv({ [ADMIN_PW]: 'sneaky' });
    expect(env[ADMIN_PW]).toBeUndefined();
  });

  it('does not mutate process.env', () => {
    process.env[ADMIN_PW] = 'still-here-in-process';
    buildChildEnv();
    expect(process.env[ADMIN_PW]).toBe('still-here-in-process');
  });
});

describe('M-4: isToolAutoApproved exact-allowlist semantics', () => {
  it('never approves under auto-deny or surface, even with an allowlist', () => {
    expect(isToolAutoApproved('auto-deny', ['read_file'], ['read_file'])).toBe(false);
    expect(isToolAutoApproved('surface', ['read_file'], ['read_file'])).toBe(false);
  });

  it('approves nothing when the allowlist is empty or absent', () => {
    expect(isToolAutoApproved('auto-approve-readonly', ['read_file'], [])).toBe(false);
    expect(isToolAutoApproved('auto-approve-readonly', ['read_file'], undefined)).toBe(false);
    expect(isToolAutoApproved('read-only', ['read_file'], undefined)).toBe(false);
  });

  it('approves only exact matches, for both auto-approve policies', () => {
    expect(isToolAutoApproved('auto-approve-readonly', ['read_file'], ['read_file'])).toBe(true);
    expect(isToolAutoApproved('read-only', ['read_file'], ['read_file'])).toBe(true);
    // Prefix / pattern resemblance is not a match (the pre-fix defect).
    expect(isToolAutoApproved('auto-approve-readonly', ['read_and_delete'], ['read_file'])).toBe(false);
    expect(isToolAutoApproved('auto-approve-readonly', ['read_file '], ['read_file'])).toBe(false);
    expect(isToolAutoApproved('auto-approve-readonly', ['Read_File'], ['read_file'])).toBe(false);
  });

  it('matches when any supplied identifier is allowlisted', () => {
    expect(isToolAutoApproved('auto-approve-readonly', ['fancy title', 'read_file'], ['read_file'])).toBe(true);
    expect(isToolAutoApproved('auto-approve-readonly', ['', 'other_tool'], ['read_file'])).toBe(false);
  });
});
