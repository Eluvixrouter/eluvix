#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { getAppPaths, type RouterConfig } from './index.js';
import {
  runEvalSuite,
  STARTER_GOLDEN_EVAL_SUITES,
  type EvalRunMode,
  type EvalSuite,
  type EvalSuiteResult,
} from './evals.js';

export function formatEvalReportTable(report: EvalSuiteResult): string {
  const lines: string[] = [];
  const badge = report.passed ? 'PASS' : 'FAIL';
  lines.push(
    `[eluvix-eval] ${badge} | Suite: "${report.suiteName}" | Mode: ${report.mode} | ${report.passedCases}/${report.totalCases} passed (${report.totalDurationMs}ms)`
  );
  lines.push('-'.repeat(88));
  for (const r of report.results) {
    const icon = r.passed ? '[PASS]' : '[FAIL]';
    lines.push(
      `${icon} ${r.id} (${r.durationMs}ms) -> tier=${r.complexityTier}, upstream=${r.selectedUpstreamId || 'none'}`
    );
    for (const a of r.assertions) {
      if (!a.passed) {
        lines.push(`       ! ${a.check}: expected ${a.expected}, got ${a.actual}`);
      }
    }
  }
  lines.push('-'.repeat(88));
  return lines.join('\n');
}

export async function runEluvixEvalCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  let suiteArg: string | undefined;
  let configArg: string | undefined;
  let modeArg: EvalRunMode | undefined;
  let jsonOutput = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--suite' && argv[i + 1]) {
      suiteArg = argv[++i];
    } else if (arg === '--config' && argv[i + 1]) {
      configArg = argv[++i];
    } else if (arg === '--mode' && argv[i + 1]) {
      const m = argv[++i];
      if (m === 'dry-run' || m === 'live') modeArg = m;
    } else if (arg === '--json') {
      jsonOutput = true;
    }
  }

  let suite: EvalSuite = STARTER_GOLDEN_EVAL_SUITES[0];
  if (suiteArg) {
    const preset = STARTER_GOLDEN_EVAL_SUITES.find((s) => s.id === suiteArg);
    if (preset) {
      suite = preset;
    } else {
      const resolvedSuite = path.resolve(suiteArg);
      const parsed = JSON.parse(fs.readFileSync(resolvedSuite, 'utf-8'));
      suite = parsed as EvalSuite;
    }
  }

  const targetConfigPath =
    configArg ||
    process.env.ELUVIX_CONFIG_PATH ||
    path.join(getAppPaths('eluvix').configDir, 'config.json');

  let config: RouterConfig = {
    egressPolicy: 'local-only',
    promptGuard: { enabled: true, action: 'block' },
    privacyGuard: { enabled: true, action: 'anonymize', redactionStyle: 'token' },
    upstreams: [
      {
        id: 'local-ollama',
        name: 'Local Ollama',
        type: 'ollama',
        endpoint: 'http://127.0.0.1:11434',
        priority: 20,
        models: ['*'],
      },
    ],
  };

  if (fs.existsSync(targetConfigPath)) {
    config = JSON.parse(fs.readFileSync(targetConfigPath, 'utf-8')) as RouterConfig;
  }

  const report = await runEvalSuite(suite, config, { mode: modeArg });
  if (jsonOutput) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(formatEvalReportTable(report) + '\n');
  }

  return report.passed ? 0 : 1;
}

const isDirectExecution =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  Boolean(process.argv[1]) &&
  /eval-cli(?:\.[cm]?[jt]s)?$/.test(process.argv[1]);

if (isDirectExecution) {
  runEluvixEvalCli()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`[eluvix-eval] Fatal error: ${err?.message || err}\n`);
      process.exit(1);
    });
}
