// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { isMcpStdioDirectExecution } from '../mcp-stdio.js';

/**
 * Regression test: the `eluvix-mcp` bin must start the stdio server.
 *
 * When the kernel executes the bin via its shebang, `process.argv[1]` is
 * the bin path (`/usr/bin/eluvix-mcp`), not `dist/mcp-stdio.js`. The old
 * guard matched only the `mcp-stdio` filename, so the installed bin exited
 * 0 silently without serving — which is exactly how a Multica agent's
 * stdio MCP server died on first spawn. Importing mcp-stdio.ts here is
 * safe: under vitest argv[1] is the runner path, so the guard does not
 * fire and no server starts.
 */
describe('isMcpStdioDirectExecution', () => {
  it.each([
    ['dist/mcp-stdio.js', true],
    ['src/mcp-stdio.ts', true],
    ['mcp-stdio.mjs', true],
    ['mcp-stdio.cjs', true],
    ['/usr/bin/eluvix-mcp', true],
    ['eluvix-mcp', true],
    ['/home/operator/.local/bin/eluvix-mcp', true],
  ])('starts the server for %s', (argv1, expected) => {
    expect(isMcpStdioDirectExecution(argv1)).toBe(expected);
  });

  it.each([
    ['/usr/bin/eluvix-eval', false],
    ['eluvix-mcp-server', false],
    ['/path/to/vitest', false],
    ['', false],
    [undefined, false],
    [null, false],
    [42, false],
  ])('does not start the server for %s', (argv1, expected) => {
    expect(isMcpStdioDirectExecution(argv1)).toBe(expected);
  });
});
