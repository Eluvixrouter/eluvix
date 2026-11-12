import { getDb } from './db.js';
import { recordAuditEvent } from './audit.js';

export interface PromptVersionRecord {
  id: string;
  version: number;
  userId: string;
  description: string | null;
  systemTemplate: string;
  variablesSchema: Record<string, any> | null;
  modelHint: string | null;
  evalScore: number | null;
  createdAt: string;
}

export interface PromptAliasRecord {
  promptId: string;
  alias: string;
  version: number;
  updatedAt: string;
  updatedBy: string;
}

export interface ResolvedPromptTemplate {
  promptId: string;
  version: number;
  alias?: string;
  renderedSystemPrompt: string;
  modelHint: string | null;
}

/**
 * Interpolates `{{varName}}` placeholders in a prompt template without recursive replacement.
 */
export function renderPromptTemplateString(
  template: string,
  variables?: Record<string, string | number | boolean | null | undefined>
): string {
  if (!template || typeof template !== 'string') return '';
  if (!variables || typeof variables !== 'object') return template;
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (fullMatch, varKey) => {
    if (Object.prototype.hasOwnProperty.call(variables, varKey)) {
      const val = variables[varKey];
      return val === undefined || val === null ? '' : String(val);
    }
    return fullMatch;
  });
}

function rowToPromptVersion(row: Record<string, any>): PromptVersionRecord {
  let variablesSchema: Record<string, any> | null = null;
  if (row.variables_schema_json) {
    try {
      variablesSchema = JSON.parse(row.variables_schema_json);
    } catch {
      variablesSchema = null;
    }
  }
  return {
    id: String(row.id),
    version: Number(row.version),
    userId: String(row.user_id || 'default'),
    description: row.description ? String(row.description) : null,
    systemTemplate: String(row.system_template),
    variablesSchema,
    modelHint: row.model_hint ? String(row.model_hint) : null,
    evalScore: typeof row.eval_score === 'number' ? Number(row.eval_score) : null,
    createdAt: String(row.created_at),
  };
}

/**
 * Registers a new immutable version (`1, 2, 3...`) for `input.id` in `prompt_registry`.
 */
export function registerPromptVersion(input: {
  id: string;
  systemTemplate: string;
  description?: string;
  variablesSchema?: Record<string, any> | null;
  modelHint?: string;
  evalScore?: number;
  userId?: string;
  autoAliasStaging?: boolean;
}): PromptVersionRecord {
  const db = getDb();
  const cleanId = (input.id || '').trim();
  if (!cleanId || !/^[a-zA-Z0-9_.:-]+$/.test(cleanId)) {
    throw new Error('Prompt ID must match /^[a-zA-Z0-9_.:-]+$/.');
  }
  if (!input.systemTemplate || typeof input.systemTemplate !== 'string') {
    throw new Error('Prompt "systemTemplate" must be a non-empty string.');
  }

  const maxRow = db
    .prepare('SELECT MAX(version) AS max_v FROM prompt_registry WHERE id = ?')
    .get(cleanId) as { max_v?: number | null } | undefined;
  const nextVersion = Number(maxRow?.max_v || 0) + 1;
  const createdAt = new Date().toISOString();
  const userId = (input.userId || 'default').trim() || 'default';

  db.prepare(
    `INSERT INTO prompt_registry (
      id, version, user_id, description, system_template, variables_schema_json, model_hint, eval_score, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    cleanId,
    nextVersion,
    userId,
    input.description?.trim() || null,
    input.systemTemplate,
    input.variablesSchema ? JSON.stringify(input.variablesSchema) : null,
    input.modelHint?.trim() || null,
    typeof input.evalScore === 'number' && Number.isFinite(input.evalScore) ? input.evalScore : null,
    createdAt
  );

  // Automatically point @latest (and @staging if requested or v1) to the new version
  const upsertAlias = db.prepare(
    `INSERT INTO prompt_aliases (prompt_id, alias, version, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(prompt_id, alias) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  );
  upsertAlias.run(cleanId, 'latest', nextVersion, createdAt, userId);
  if (input.autoAliasStaging !== false) {
    upsertAlias.run(cleanId, 'staging', nextVersion, createdAt, userId);
  }
  if (nextVersion === 1) {
    upsertAlias.run(cleanId, 'production', 1, createdAt, userId);
  }

  try {
    recordAuditEvent({
      actorId: userId,
      actorRole: 'operator',
      action: 'prompt.register',
      resourceType: 'prompt',
      resourceId: `${cleanId}@v${nextVersion}`,
      details: {
        promptId: cleanId,
        version: nextVersion,
        evalScore: input.evalScore ?? null,
      },
    });
  } catch {}

  return getPromptVersion(cleanId, nextVersion)!;
}

export function getPromptVersion(id: string, version: number): PromptVersionRecord | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM prompt_registry WHERE id = ? AND version = ?')
    .get(id, version) as Record<string, any> | undefined;
  return row ? rowToPromptVersion(row) : null;
}

export function listPromptVersions(id?: string): Array<PromptVersionRecord & { aliases: string[] }> {
  const db = getDb();
  const rows = (
    id
      ? db.prepare('SELECT * FROM prompt_registry WHERE id = ? ORDER BY version DESC').all(id)
      : db.prepare('SELECT * FROM prompt_registry ORDER BY id ASC, version DESC').all()
  ) as Array<Record<string, any>>;

  const aliasRows = (
    id
      ? db.prepare('SELECT * FROM prompt_aliases WHERE prompt_id = ?').all(id)
      : db.prepare('SELECT * FROM prompt_aliases').all()
  ) as Array<Record<string, any>>;

  return rows.map((r) => {
    const rec = rowToPromptVersion(r);
    const matchingAliases = aliasRows
      .filter((a) => String(a.prompt_id) === rec.id && Number(a.version) === rec.version)
      .map((a) => String(a.alias));
    return { ...rec, aliases: matchingAliases };
  });
}

/**
 * Promotes or reassigns a prompt alias (e.g. `production`, `staging`, `canary`) to a specific version.
 * When `minEvalScore` is provided, verifies that the target version's `evalScore >= minEvalScore`
 * before allowing promotion.
 */
export function promotePromptAlias(input: {
  promptId: string;
  alias: string;
  version: number;
  minEvalScore?: number;
  actorId?: string;
}): PromptAliasRecord {
  const db = getDb();
  const promptId = input.promptId.trim();
  const alias = input.alias.trim().replace(/^@/, '');
  const target = getPromptVersion(promptId, input.version);
  if (!target) {
    throw new Error(`Prompt version "${promptId}@v${input.version}" does not exist.`);
  }

  if (typeof input.minEvalScore === 'number' && Number.isFinite(input.minEvalScore)) {
    const actualScore = target.evalScore ?? 0;
    if (actualScore < input.minEvalScore) {
      throw new Error(
        `Eval gate rejected promotion of "${promptId}@v${input.version}" to @${alias}: evalScore ${actualScore.toFixed(
          2
        )} < required ${input.minEvalScore.toFixed(2)}.`
      );
    }
  }

  const updatedAt = new Date().toISOString();
  const updatedBy = (input.actorId || 'default').trim() || 'default';

  db.prepare(
    `INSERT INTO prompt_aliases (prompt_id, alias, version, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(prompt_id, alias) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).run(promptId, alias, input.version, updatedAt, updatedBy);

  try {
    recordAuditEvent({
      actorId: updatedBy,
      actorRole: 'admin',
      action: 'prompt.promote',
      resourceType: 'prompt_alias',
      resourceId: `${promptId}@${alias}`,
      details: {
        promptId,
        alias,
        version: input.version,
        evalScore: target.evalScore,
        minEvalScore: input.minEvalScore ?? null,
      },
    });
  } catch {}

  return {
    promptId,
    alias,
    version: input.version,
    updatedAt,
    updatedBy,
  };
}

/**
 * Resolves a prompt reference (`support-triage@production`, `support-triage@v2`, `support-triage@2`,
 * or `support-triage`) and renders `{{variables}}`.
 */
export function resolvePromptTemplate(
  promptRef: string,
  variables?: Record<string, string | number | boolean | null | undefined>
): ResolvedPromptTemplate | null {
  if (!promptRef || typeof promptRef !== 'string') return null;
  const trimmed = promptRef.trim();
  const atIdx = trimmed.indexOf('@');
  const promptId = (atIdx !== -1 ? trimmed.slice(0, atIdx) : trimmed).trim();
  const selector = (atIdx !== -1 ? trimmed.slice(atIdx + 1) : 'production').trim();
  if (!promptId) return null;

  const db = getDb();
  let versionRecord: PromptVersionRecord | null = null;
  let resolvedAlias: string | undefined;

  const explicitVerMatch = /^v?(\d+)$/i.exec(selector);
  if (explicitVerMatch) {
    versionRecord = getPromptVersion(promptId, Number(explicitVerMatch[1]));
  } else {
    const aliasRow = db
      .prepare('SELECT version FROM prompt_aliases WHERE prompt_id = ? AND alias = ?')
      .get(promptId, selector) as { version?: number } | undefined;
    if (aliasRow && typeof aliasRow.version === 'number') {
      resolvedAlias = selector;
      versionRecord = getPromptVersion(promptId, aliasRow.version);
    } else if (selector === 'production') {
      const latestRow = db
        .prepare('SELECT * FROM prompt_registry WHERE id = ? ORDER BY version DESC LIMIT 1')
        .get(promptId) as Record<string, any> | undefined;
      if (latestRow) {
        versionRecord = rowToPromptVersion(latestRow);
      }
    }
  }

  if (!versionRecord) return null;

  return {
    promptId: versionRecord.id,
    version: versionRecord.version,
    alias: resolvedAlias,
    renderedSystemPrompt: renderPromptTemplateString(versionRecord.systemTemplate, variables),
    modelHint: versionRecord.modelHint,
  };
}
