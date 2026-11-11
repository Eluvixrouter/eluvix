import { applyPrivacyGuard, type PrivacyGuardConfig } from './guard.js';
import { evaluateDraftQuality } from './cascade.js';
import * as dbModule from './db.js';
import type { DistillationPairRecord } from './db.js';

export interface ScrubbedDistillationPayload {
  promptMessages: Array<Record<string, any>>;
  chosenText: string;
  rejectedText: string;
  privacyScrubbed: boolean;
}

/**
 * Scrubs PII, API keys, emails, SSNs, credit cards, phone numbers, and custom regexes
 * from prompt history, Teacher (`chosen`), and Student (`rejected`) completions BEFORE
 * persisting any distillation training row to SQLite.
 */
export function scrubForDistillation(
  promptMessages: Array<Record<string, any>>,
  chosenText: string,
  rejectedText: string,
  privacyConfig?: PrivacyGuardConfig
): ScrubbedDistillationPayload {
  const effectiveGuard: PrivacyGuardConfig = {
    enabled: true,
    action: 'anonymize',
    redactionStyle:
      privacyConfig?.redactionStyle === 'hash' || privacyConfig?.redactionStyle === 'asterisk'
        ? privacyConfig.redactionStyle
        : 'token',
    detectPii: privacyConfig?.detectPii,
    customPatterns: privacyConfig?.customPatterns,
    whitelist: privacyConfig?.whitelist,
    auditLogging: false,
  };

  const scrubbedPromptRes = applyPrivacyGuard(promptMessages as any[], effectiveGuard);
  const scrubbedChosenRes = applyPrivacyGuard(
    [{ role: 'assistant', content: chosenText || '' }],
    effectiveGuard
  );
  const scrubbedRejectedRes = applyPrivacyGuard(
    [{ role: 'assistant', content: rejectedText || '' }],
    effectiveGuard
  );

  const safeChosen =
    typeof scrubbedChosenRes.modifiedMessages?.[0]?.content === 'string'
      ? scrubbedChosenRes.modifiedMessages[0].content
      : chosenText || '';
  const safeRejected =
    typeof scrubbedRejectedRes.modifiedMessages?.[0]?.content === 'string'
      ? scrubbedRejectedRes.modifiedMessages[0].content
      : rejectedText || '';

  return {
    promptMessages: (scrubbedPromptRes.modifiedMessages as Array<Record<string, any>>) || promptMessages,
    chosenText: safeChosen,
    rejectedText: safeRejected,
    privacyScrubbed: true,
  };
}

/**
 * Evaluates a `$0.00` deterministic rubric quality score (`0.0` - `1.0`) comparing
 * Teacher (`chosenText`) against Student (`rejectedText`).
 * - Rejects (`0.0`) pairs where the Teacher output itself is empty, truncated, or a refusal.
 * - Assigns higher contrastive DPO scores (`0.82` - `0.98`) when Teacher resolves a Student
 *   structural failure, refusal, or low-confidence response.
 */
export function scoreDistillationPairQuality(
  chosenText: string,
  rejectedText: string,
  options?: { expectJson?: boolean; expectCode?: boolean }
): number {
  const teacherEval = evaluateDraftQuality(chosenText, {
    confidenceThreshold: 0.7,
    expectJson: options?.expectJson,
    expectCode: options?.expectCode,
  });
  if (!teacherEval.passed) {
    return 0;
  }

  const cleanChosen = chosenText.trim();
  const cleanRejected = (rejectedText || '').trim();

  if (!cleanRejected) {
    // Usable for SFT, weaker contrastive signal for DPO
    return 0.65;
  }
  if (cleanChosen === cleanRejected) {
    return 0.55;
  }

  const studentEval = evaluateDraftQuality(cleanRejected, {
    confidenceThreshold: 0.78,
    expectJson: options?.expectJson,
    expectCode: options?.expectCode,
  });

  let score = 0.82;
  if (!studentEval.passed) {
    score += 0.12;
  }
  const lengthRatio = cleanChosen.length / Math.max(1, cleanRejected.length);
  if (lengthRatio >= 1.15 && lengthRatio <= 8.0) {
    score += 0.04;
  }

  return Number(Math.max(0, Math.min(0.99, score)).toFixed(4));
}

/**
 * Scrubs, scores, and persists a Teacher vs. Student distillation example to SQLite.
 */
export function captureDistillationPair(input: {
  userId?: string;
  source?: 'shadow' | 'cascade-escalation' | 'arena-vote';
  teacherUpstreamId: string;
  studentUpstreamId: string;
  teacherModel: string;
  studentModel: string;
  promptMessages: Array<Record<string, any>>;
  chosenText: string;
  rejectedText: string;
  privacyConfig?: PrivacyGuardConfig;
  expectJson?: boolean;
  expectCode?: boolean;
  judgeScoreOverride?: number;
}): DistillationPairRecord | null {
  if (!input.chosenText || input.chosenText.trim().length === 0) {
    return null;
  }

  const scrubbed = scrubForDistillation(
    input.promptMessages || [],
    input.chosenText,
    input.rejectedText || '',
    input.privacyConfig
  );

  const judgeScore =
    typeof input.judgeScoreOverride === 'number' && Number.isFinite(input.judgeScoreOverride)
      ? Math.max(0, Math.min(1, input.judgeScoreOverride))
      : scoreDistillationPairQuality(scrubbed.chosenText, scrubbed.rejectedText, {
          expectJson: input.expectJson,
          expectCode: input.expectCode,
        });

  if (judgeScore <= 0) {
    return null;
  }

  try {
    if (typeof (dbModule as any).saveDistillationPair === 'function') {
      return dbModule.saveDistillationPair({
        userId: input.userId || 'default',
        source: input.source || 'shadow',
        teacherUpstreamId: input.teacherUpstreamId,
        studentUpstreamId: input.studentUpstreamId,
        teacherModel: input.teacherModel,
        studentModel: input.studentModel,
        promptMessages: scrubbed.promptMessages,
        chosenText: scrubbed.chosenText,
        rejectedText: scrubbed.rejectedText,
        judgeScore,
        privacyScrubbed: scrubbed.privacyScrubbed,
      });
    }
  } catch {
    // Tolerate partial ../db.js mocks in unit tests
  }
  return null;
}

/**
 * Exports distillation records in OpenAI / Unsloth / Axolotl Supervised Fine-Tuning (SFT) JSONL format.
 */
export function formatDistillationAsSftJsonl(pairs: DistillationPairRecord[]): string {
  return pairs
    .filter((p) => p.chosen_text && p.chosen_text.trim().length > 0)
    .map((p) =>
      JSON.stringify({
        messages: [
          ...(Array.isArray(p.prompt_messages) ? p.prompt_messages : []),
          { role: 'assistant', content: p.chosen_text },
        ],
        metadata: {
          id: p.id,
          source: p.source,
          teacher_upstream_id: p.teacher_upstream_id,
          teacher_model: p.teacher_model,
          judge_score: p.judge_score,
          privacy_scrubbed: p.privacy_scrubbed,
          created_at: p.created_at,
        },
      })
    )
    .join('\n');
}

/**
 * Exports distillation records in TRL / Unsloth / Axolotl Direct Preference Optimization (DPO) JSONL format.
 */
export function formatDistillationAsDpoJsonl(pairs: DistillationPairRecord[]): string {
  return pairs
    .filter(
      (p) =>
        p.chosen_text &&
        p.chosen_text.trim().length > 0 &&
        p.rejected_text &&
        p.rejected_text.trim().length > 0 &&
        p.chosen_text.trim() !== p.rejected_text.trim()
    )
    .map((p) =>
      JSON.stringify({
        prompt: Array.isArray(p.prompt_messages) ? p.prompt_messages : [],
        chosen: [{ role: 'assistant', content: p.chosen_text }],
        rejected: [{ role: 'assistant', content: p.rejected_text }],
        score: p.judge_score,
        metadata: {
          id: p.id,
          source: p.source,
          teacher_upstream_id: p.teacher_upstream_id,
          student_upstream_id: p.student_upstream_id,
          teacher_model: p.teacher_model,
          student_model: p.student_model,
          privacy_scrubbed: p.privacy_scrubbed,
          created_at: p.created_at,
        },
      })
    )
    .join('\n');
}
