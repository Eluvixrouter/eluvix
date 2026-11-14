import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestResult,
} from '../paperclip-types.js';
import { resolveEluvixApiKey, validateLoopbackEluvixUrl } from './headers.js';

const execFileAsync = promisify(execFile);

export async function testEluvixEnvironment(
  ctx: {
    companyId: string;
    adapterType: string;
    config: Record<string, unknown>;
  },
  deps?: { fetch?: typeof globalThis.fetch }
): Promise<AdapterEnvironmentTestResult> {
  const fetchFn = deps?.fetch || globalThis.fetch;
  const checks: AdapterEnvironmentCheck[] = [];

  const rawBaseUrl = String(ctx.config.eluvixBaseUrl || 'http://127.0.0.1:3588');
  const urlCheck = validateLoopbackEluvixUrl(rawBaseUrl);
  if (!urlCheck.ok) {
    checks.push({
      code: 'eluvix_url_invalid',
      level: 'error',
      message: urlCheck.reason,
      hint: 'Use http://127.0.0.1:3588 for same-machine Eluvix.',
    });
    return {
      adapterType: ctx.adapterType,
      status: 'fail',
      checks,
      testedAt: new Date().toISOString(),
    };
  }
  checks.push({
    code: 'eluvix_url_loopback',
    level: 'info',
    message: `Loopback Eluvix URL verified: ${urlCheck.url}`,
  });

  const apiKey = resolveEluvixApiKey(
    ctx.config,
    (ctx.config.env as Record<string, string | undefined>) || {}
  );
  if (!apiKey) {
    checks.push({
      code: 'eluvix_api_key_missing',
      level: 'error',
      message: 'No Eluvix API key configured.',
      hint: 'Set ELUVIX_API_KEY via Paperclip envBindings or eluvixApiKey.',
    });
  } else {
    try {
      const whoamiRes = await fetchFn(`${urlCheck.url}/api/v1/paperclip/whoami`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (whoamiRes.ok) {
        const whoami: any = await whoamiRes.json();
        checks.push({
          code: 'eluvix_whoami_ok',
          level: 'info',
          message: `Eluvix authenticated as user "${whoami.userId}" (egress=${whoami.egressPolicy}, paperclipPolicy=${whoami.paperclipIntegrationEnabled ? 'enabled' : 'disabled'})`,
        });
      } else {
        checks.push({
          code: 'eluvix_whoami_failed',
          level: 'error',
          message: `Eluvix whoami returned HTTP ${whoamiRes.status}`,
          hint: 'Ensure the elx_ key has "chat" and "paperclip" scopes.',
        });
      }
    } catch (err: any) {
      checks.push({
        code: 'eluvix_unreachable',
        level: 'error',
        message: `Cannot reach Eluvix at ${urlCheck.url}: ${err?.message || 'network error'}`,
        hint: 'Start Eluvix gateway on port 3588.',
      });
    }
  }

  const binary = String(ctx.config.opencodeBinary || 'opencode');
  try {
    const { stdout } = await execFileAsync(binary, ['--version'], { timeout: 4000 });
    checks.push({
      code: 'opencode_binary_ok',
      level: 'info',
      message: `OpenCode CLI detected: ${stdout.trim() || binary}`,
    });
  } catch {
    checks.push({
      code: 'opencode_binary_missing',
      level: 'warn',
      message: `OpenCode CLI "${binary}" not found on PATH.`,
      hint: 'Install OpenCode or specify opencodeBinary.',
    });
  }

  const hasError = checks.some((c) => c.level === 'error');
  const hasWarn = checks.some((c) => c.level === 'warn');
  return {
    adapterType: ctx.adapterType,
    status: hasError ? 'fail' : hasWarn ? 'warn' : 'pass',
    checks,
    testedAt: new Date().toISOString(),
  };
}
