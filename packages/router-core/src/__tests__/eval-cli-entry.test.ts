// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { isEvalCliDirectExecution } from '../eval-cli.js';

/**
 * Regression test: the `eluvix-eval` bin must run the eval suite.
 *
 * When the kernel executes the bin via its shebang, `process.argv[1]` is
 * the bin path (`/usr/bin/eluvix-eval`), not `dist/eval-cli.js`. The old
 * guard matched only the `eval-cli` filename, so the installed bin exited
 * 0 silently without running anything. Importing eval-cli.ts here is
 * safe: under vitest argv[1] is the runner path, so the guard does not
 * fire and no suite runs.
 */
describe('isEvalCliDirectExecution', () => {
  it.each([
    ['dist/eval-cli.js', true],
    ['src/eval-cli.ts', true],
    ['eval-cli.mjs', true],
    ['eval-cli.cjs', true],
    ['/usr/bin/eluvix-eval', true],
    ['eluvix-eval', true],
    ['/home/operator/.local/bin/eluvix-eval', true],
  ])('runs the suite for %s', (argv1, expected) => {
    expect(isEvalCliDirectExecution(argv1)).toBe(expected);
  });

  it.each([
    ['/usr/bin/eluvix-mcp', false],
    ['eluvix-eval-server', false],
    ['/path/to/vitest', false],
    ['', false],
    [undefined, false],
    [null, false],
    [42, false],
  ])('does not run the suite for %s', (argv1, expected) => {
    expect(isEvalCliDirectExecution(argv1)).toBe(expected);
  });

  it('old guard missed the installed bin (negative control)', () => {
    const oldGuard = /eval-cli(?:\.[cm]?[jt]s)?$/;
    expect(oldGuard.test('/usr/bin/eluvix-eval')).toBe(false);
    expect(oldGuard.test('dist/eval-cli.js')).toBe(true);
  });
});
