import { describe, it, expect } from 'vitest';
import { classifyChatError } from '../chat-error';

describe('classifyChatError (bug hunt finding 3)', () => {
  it('classifies the failover-budget error as a timeout (504), not a bad gateway (502)', () => {
    // The exact message router-core throws when the failover budget is
    // exhausted: it starts with the generic aggregate prefix AND carries
    // the timeout marker.
    const err = new Error(
      'All upstreams failed to process the request. Failover timed out after 120000ms (budget 120000ms, 3 attempt(s) made); remaining candidates were not tried.'
    );
    expect(classifyChatError(err)).toBe('timeout');
  });

  it('keeps the plain aggregate failure at all-upstreams-failed (502)', () => {
    expect(classifyChatError(new Error('All upstreams failed to process the request.'))).toBe(
      'all-upstreams-failed'
    );
  });

  it('classifies no-upstream errors first', () => {
    expect(classifyChatError(new Error('No upstream available for model: gemini-9-ultra'))).toBe('no-upstream');
    expect(
      classifyChatError(new Error('No upstream available for model: auto with vision capability'))
    ).toBe('no-upstream');
  });

  it('classifies client aborts, preserving their precedence over timeouts', () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    expect(classifyChatError(abort)).toBe('client-aborted');
    expect(classifyChatError(new Error('Client aborted'))).toBe('client-aborted');
    expect(classifyChatError(new Error('client_closed_request'))).toBe('client-aborted');
  });

  it('classifies timeout-shaped errors as timeouts', () => {
    const named = new Error('socket hang up');
    named.name = 'TimeoutError';
    expect(classifyChatError(named)).toBe('timeout');
    expect(classifyChatError(new Error('Upstream request timed out after 60000ms'))).toBe('timeout');
  });

  it('falls back to server-error for anything else', () => {
    expect(classifyChatError(new Error('database is locked'))).toBe('server-error');
    expect(classifyChatError(new Error(''))).toBe('server-error');
  });
});
