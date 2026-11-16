import { useState, type CSSProperties } from 'react';
import {
  useHostContext,
  useHostNavigation,
  usePluginAction,
  usePluginData,
  usePluginToast,
  type PluginDetailTabProps,
  type PluginPageProps,
  type PluginSidebarProps,
  type PluginWidgetProps,
} from '@paperclipai/plugin-sdk/ui';
import { manifest } from '../manifest.js';

export const uiSlots = manifest.ui.slots;

type RecommendationRow = {
  agentId: string;
  name: string;
  confidence: number;
  score: number;
  estimatedCostUsd: number;
  estimatedLatencyMs?: number;
  rationale: string;
  matchedCapabilities?: string[];
  breakdown?: {
    fit: number;
    cost: number;
    latency: number;
    load: number;
    budget: number;
    history: number;
  };
  budgetForecast?: {
    projectedDaysRemaining: number | null;
    exhaustsWithinDays: number | null;
  } | null;
};

type ExcludedRow = {
  agentId: string;
  name: string;
  reasonCode: string;
  reason: string;
};

type PendingApproval = {
  issueId: string;
  companyId: string;
  identifier?: string;
  title: string;
  recommendedAgentId: string;
  recommendedAgentName: string;
  confidence: number;
  estimatedCostUsd: number;
  rationale: string;
  status: string;
};

type IssueOverviewData = {
  issue?: {
    id: string;
    title: string;
    status: string;
    priority?: string;
    assigneeAgentId?: string | null;
  } | null;
  classification?: {
    modalities?: string[];
    complexity?: number;
    complexityLabel?: string;
    sensitivity?: string;
    suggestedTier?: string;
    taskClass?: string;
  } | null;
  recommendations: RecommendationRow[];
  excluded: ExcludedRow[];
  pendingApproval?: PendingApproval | null;
  autoAssignMode?: string;
  error?: string;
};

type DashboardOverviewData = {
  capabilities?: {
    upstreams?: Array<{
      id: string;
      name: string;
      type: string;
      isLocal: boolean;
      healthy: boolean;
      models: string[];
      costPer1kTokens: number;
      estimatedLatencyMs?: number;
    }>;
  } | null;
  whoami?: {
    spend?: {
      last24hUsd?: number;
      dailyBudgetUsd?: number;
    };
  } | null;
  agents: Array<{
    id: string;
    name: string;
    role?: string;
    title?: string;
    status?: string;
    openIssueCount?: number;
    budgetMonthlyCents?: number;
    spentMonthlyCents?: number;
    isEluvixAuto?: boolean;
  }>;
  pendingApprovals: PendingApproval[];
  safetyFuse?: {
    tripped: boolean;
    trippedAt?: string;
    failureRate?: number;
    outcomes?: unknown[];
  } | null;
  autoAssignMode: string;
};

type AgentPerformanceData = {
  agent?: {
    id: string;
    name: string;
    role?: string;
    title?: string;
    status?: string;
    openIssueCount?: number;
    budgetMonthlyCents?: number;
    spentMonthlyCents?: number;
    model?: string;
  } | null;
  recommendation?: RecommendationRow | null;
  excluded?: ExcludedRow | null;
  error?: string;
};

const stackStyle: CSSProperties = {
  display: 'grid',
  gap: '12px',
};

const cardStyle: CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: '12px',
  padding: '14px',
  background: 'var(--card, transparent)',
};

const subCardStyle: CSSProperties = {
  border: '1px solid color-mix(in srgb, var(--border) 70%, transparent)',
  borderRadius: '10px',
  padding: '10px 12px',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '8px',
};

const betweenStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '8px',
};

const badgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  borderRadius: '999px',
  border: '1px solid var(--border)',
  padding: '2px 8px',
  fontSize: '11px',
  fontWeight: 500,
};

const buttonStyle: CSSProperties = {
  appearance: 'none',
  border: '1px solid var(--border)',
  borderRadius: '8px',
  background: 'transparent',
  color: 'inherit',
  padding: '5px 10px',
  fontSize: '12px',
  cursor: 'pointer',
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: 'var(--primary, #10b981)',
  color: 'var(--primary-foreground, #ffffff)',
  borderColor: 'transparent',
  fontWeight: 600,
};

const mutedStyle: CSSProperties = {
  color: 'var(--muted-foreground, #71717a)',
  fontSize: '12px',
};

function fmtUsd(value?: number): string {
  return `$${Number(value || 0).toFixed(4)}`;
}

function fmtPct(value?: number): string {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

function resolveSwitchyardPath(context: { companyPrefix?: string | null }): string {
  return context.companyPrefix ? `/${context.companyPrefix}/plugins/switchyard` : '/plugins/switchyard';
}

export function IssueRecommendationCard({ context }: PluginWidgetProps) {
  const host = useHostContext();
  const toast = usePluginToast();
  const companyId = context.companyId || host.companyId;
  const issueId = context.entityId || host.entityId;

  const { data, loading, error, refresh } = usePluginData<IssueOverviewData>(
    'eluvix:issue_overview',
    companyId && issueId ? { companyId, issueId } : undefined
  );
  const approveAction = usePluginAction('eluvix:approve_assignment');
  const dismissAction = usePluginAction('eluvix:dismiss_assignment');
  const assignAction = usePluginAction('eluvix:assign_candidate');
  const [busyId, setBusyId] = useState<string | null>(null);

  if (!companyId || !issueId) return null;
  if (loading) return <div style={cardStyle}>Loading Eluvix Switchyard recommendations…</div>;
  if (error) {
    return (
      <div style={cardStyle}>
        <div style={betweenStyle}>
          <strong>Eluvix Switchyard</strong>
          <button type="button" style={buttonStyle} onClick={refresh}>
            Retry
          </button>
        </div>
        <div style={mutedStyle}>{error.message}</div>
      </div>
    );
  }
  if (!data) return null;

  async function runAction(
    id: string,
    fn: () => Promise<unknown>,
    successTitle: string
  ) {
    setBusyId(id);
    try {
      await fn();
      toast({ title: successTitle, tone: 'success' });
      refresh();
    } catch (err: any) {
      toast({
        title: 'Eluvix Switchyard action failed',
        description: err?.message || 'Unknown error',
        tone: 'error',
      });
    } finally {
      setBusyId(null);
    }
  }

  const pending = data.pendingApproval?.status === 'pending' ? data.pendingApproval : null;
  const cls = data.classification;

  return (
    <div style={{ ...cardStyle, ...stackStyle }}>
      <div style={betweenStyle}>
        <div style={rowStyle}>
          <strong>Eluvix Switchyard Delegation</strong>
          {data.autoAssignMode && <span style={badgeStyle}>mode: {data.autoAssignMode}</span>}
          {cls?.suggestedTier && <span style={badgeStyle}>tier: {cls.suggestedTier}</span>}
          {cls?.sensitivity && <span style={badgeStyle}>sensitivity: {cls.sensitivity}</span>}
          {cls?.complexityLabel && <span style={badgeStyle}>{cls.complexityLabel}</span>}
        </div>
        <button type="button" style={buttonStyle} onClick={refresh}>
          Refresh
        </button>
      </div>

      {pending && (
        <div
          style={{
            ...subCardStyle,
            borderColor: 'var(--primary, #10b981)',
            display: 'grid',
            gap: '8px',
          }}
        >
          <div style={betweenStyle}>
            <div>
              <strong>Approval Required: {pending.recommendedAgentName}</strong>
              <div style={mutedStyle}>
                Confidence {fmtPct(pending.confidence)} · Est. {fmtUsd(pending.estimatedCostUsd)}
              </div>
            </div>
            <div style={rowStyle}>
              <button
                type="button"
                style={primaryButtonStyle}
                disabled={busyId !== null}
                onClick={() =>
                  runAction(
                    'approve',
                    () =>
                      approveAction({
                        companyId,
                        issueId,
                        agentId: pending.recommendedAgentId,
                        agentName: pending.recommendedAgentName,
                      }),
                    `Assigned to ${pending.recommendedAgentName}`
                  )
                }
              >
                {busyId === 'approve' ? 'Approving…' : 'Approve & Assign'}
              </button>
              <button
                type="button"
                style={buttonStyle}
                disabled={busyId !== null}
                onClick={() =>
                  runAction(
                    'dismiss',
                    () => dismissAction({ companyId, issueId, reason: 'operator_dismissed' }),
                    'Proposal dismissed'
                  )
                }
              >
                Dismiss
              </button>
            </div>
          </div>
          {pending.rationale && <div style={mutedStyle}>{pending.rationale}</div>}
        </div>
      )}

      {data.recommendations.length === 0 ? (
        <div style={mutedStyle}>No eligible assignees matched Switchyard constraints.</div>
      ) : (
        <div style={stackStyle}>
          {data.recommendations.map((rec, idx) => (
            <div key={rec.agentId} style={subCardStyle}>
              <div style={betweenStyle}>
                <div style={rowStyle}>
                  <span style={badgeStyle}>#{idx + 1}</span>
                  <strong>{rec.name}</strong>
                  <span style={badgeStyle}>Conf {fmtPct(rec.confidence)}</span>
                  <span style={badgeStyle}>Est {fmtUsd(rec.estimatedCostUsd)}</span>
                  {rec.budgetForecast?.projectedDaysRemaining != null && (
                    <span style={badgeStyle}>
                      Runway ~{rec.budgetForecast.projectedDaysRemaining}d
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  style={buttonStyle}
                  disabled={busyId !== null || data.issue?.assigneeAgentId === rec.agentId}
                  onClick={() =>
                    runAction(
                      `assign:${rec.agentId}`,
                      () =>
                        assignAction({
                          companyId,
                          issueId,
                          agentId: rec.agentId,
                          agentName: rec.name,
                        }),
                      `Assigned issue to ${rec.name}`
                    )
                  }
                >
                  {data.issue?.assigneeAgentId === rec.agentId
                    ? 'Assigned'
                    : busyId === `assign:${rec.agentId}`
                      ? 'Assigning…'
                      : 'Assign'}
                </button>
              </div>
              {rec.rationale && <div style={{ ...mutedStyle, marginTop: '4px' }}>{rec.rationale}</div>}
              {rec.breakdown && (
                <div style={{ ...rowStyle, marginTop: '6px' }}>
                  <span style={mutedStyle}>Fit {fmtPct(rec.breakdown.fit)}</span>
                  <span style={mutedStyle}>Cost {fmtPct(rec.breakdown.cost)}</span>
                  <span style={mutedStyle}>Latency {fmtPct(rec.breakdown.latency)}</span>
                  <span style={mutedStyle}>Load {fmtPct(rec.breakdown.load)}</span>
                  <span style={mutedStyle}>Budget {fmtPct(rec.breakdown.budget)}</span>
                  <span style={mutedStyle}>History {fmtPct(rec.breakdown.history)}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {data.excluded.length > 0 && (
        <div style={mutedStyle}>
          Excluded:{' '}
          {data.excluded.map((ex) => `${ex.name} (${ex.reasonCode})`).join(' · ')}
        </div>
      )}
    </div>
  );
}

export function SwitchyardDashboardPage({ context }: PluginPageProps) {
  const host = useHostContext();
  const nav = useHostNavigation();
  const toast = usePluginToast();
  const companyId = context.companyId || host.companyId;
  const { data, loading, error, refresh } = usePluginData<DashboardOverviewData>(
    'eluvix:dashboard_overview',
    companyId ? { companyId } : undefined
  );
  const approveAction = usePluginAction('eluvix:approve_assignment');
  const dismissAction = usePluginAction('eluvix:dismiss_assignment');
  const explainAction = usePluginAction('eluvix:explain_route');
  const resetFuseAction = usePluginAction('eluvix:reset_safety_fuse');

  const [prompt, setPrompt] = useState('Refactor authentication middleware with zero PII egress');
  const [priority, setPriority] = useState<'critical' | 'high' | 'medium' | 'low'>('high');
  const [sensitivity, setSensitivity] = useState<'public' | 'internal' | 'confidential'>('internal');
  const [explainResult, setExplainResult] = useState<any>(null);
  const [explaining, setExplaining] = useState(false);

  async function handleExplain() {
    setExplaining(true);
    try {
      const res = await explainAction({ prompt, priority, sensitivity });
      setExplainResult(res);
    } catch (err: any) {
      toast({
        title: 'Route explain failed',
        description: err?.message || 'Error',
        tone: 'error',
      });
    } finally {
      setExplaining(false);
    }
  }

  return (
    <div style={{ ...stackStyle, padding: '16px' }}>
      <div style={betweenStyle}>
        <div>
          <h2 style={{ margin: 0, fontSize: '18px' }}>Eluvix Switchyard Control Plane</h2>
          <div style={mutedStyle}>
            Auto-assign mode: <strong>{data?.autoAssignMode || 'advisory'}</strong> · 24h Spend:{' '}
            <strong>${Number(data?.whoami?.spend?.last24hUsd || 0).toFixed(4)}</strong>
            {data?.whoami?.spend?.dailyBudgetUsd
              ? ` / $${Number(data.whoami.spend.dailyBudgetUsd).toFixed(2)}`
              : ''}
          </div>
        </div>
        <button type="button" style={buttonStyle} onClick={refresh}>
          Refresh Fleet
        </button>
      </div>

      {loading && <div style={cardStyle}>Loading Switchyard fleet state…</div>}
      {error && <div style={cardStyle}>Error: {error.message}</div>}

      {data && (
        <>
          {data.safetyFuse?.tripped && (
            <div
              style={{
                ...cardStyle,
                borderColor: '#f59e0b',
                backgroundColor: 'rgba(120, 53, 15, 0.2)',
              }}
            >
              <div style={betweenStyle}>
                <div>
                  <strong style={{ color: '#fcd34d' }}>
                    Safety Fuse Tripped — Auto-Assign downgraded to Approval Required
                  </strong>
                  <div style={mutedStyle}>
                    Recent outcome failure rate{' '}
                    {typeof data.safetyFuse.failureRate === 'number'
                      ? `${Math.round(data.safetyFuse.failureRate * 100)}%`
                      : 'exceeded threshold'}
                    {data.safetyFuse.trippedAt ? ` · tripped at ${data.safetyFuse.trippedAt}` : ''}
                    . Mode &quot;auto&quot; is temporarily held at &quot;auto-with-approval&quot;.
                  </div>
                </div>
                <button
                  type="button"
                  style={primaryButtonStyle}
                  onClick={async () => {
                    await resetFuseAction({ companyId });
                    toast({ title: 'Safety fuse reset', tone: 'success' });
                    refresh();
                  }}
                >
                  Reset Safety Fuse
                </button>
              </div>
            </div>
          )}

          <div style={cardStyle}>
            <div style={betweenStyle}>
              <strong>Pending Approval Queue ({data.pendingApprovals.length})</strong>
            </div>
            {data.pendingApprovals.length === 0 ? (
              <div style={{ ...mutedStyle, marginTop: '6px' }}>
                No pending assignment proposals.
              </div>
            ) : (
              <div style={{ ...stackStyle, marginTop: '10px' }}>
                {data.pendingApprovals.map((item) => (
                  <div key={item.issueId} style={subCardStyle}>
                    <div style={betweenStyle}>
                      <div>
                        <strong>{item.identifier ? `${item.identifier} · ` : ''}{item.title}</strong>
                        <div style={mutedStyle}>
                          Proposed: <strong>{item.recommendedAgentName}</strong> · Conf{' '}
                          {fmtPct(item.confidence)} · Est {fmtUsd(item.estimatedCostUsd)}
                        </div>
                      </div>
                      <div style={rowStyle}>
                        <button
                          type="button"
                          style={primaryButtonStyle}
                          onClick={async () => {
                            await approveAction({
                              companyId,
                              issueId: item.issueId,
                              agentId: item.recommendedAgentId,
                              agentName: item.recommendedAgentName,
                            });
                            toast({ title: `Approved ${item.recommendedAgentName}`, tone: 'success' });
                            refresh();
                          }}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          style={buttonStyle}
                          onClick={async () => {
                            await dismissAction({ companyId, issueId: item.issueId });
                            toast({ title: 'Proposal dismissed', tone: 'info' });
                            refresh();
                          }}
                        >
                          Dismiss
                        </button>
                        {item.identifier && (
                          <button
                            type="button"
                            style={buttonStyle}
                            onClick={() =>
                              nav.navigate(
                                context.companyPrefix
                                  ? `/${context.companyPrefix}/issues/${item.identifier}`
                                  : `/issues/${item.issueId}`
                              )
                            }
                          >
                            View Issue
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={cardStyle}>
            <strong>Active Switchyard Upstreams</strong>
            <div style={{ ...stackStyle, marginTop: '10px' }}>
              {(data.capabilities?.upstreams || []).map((u) => (
                <div key={u.id} style={subCardStyle}>
                  <div style={betweenStyle}>
                    <div style={rowStyle}>
                      <strong>{u.name || u.id}</strong>
                      <span style={badgeStyle}>{u.isLocal ? 'Sovereign Local' : 'Cloud'}</span>
                      <span style={badgeStyle}>{u.type}</span>
                      <span style={badgeStyle}>{u.healthy ? 'Healthy' : 'Degraded'}</span>
                    </div>
                    <div style={mutedStyle}>
                      {u.models?.length || 0} models · ${Number(u.costPer1kTokens || 0).toFixed(4)}/1k
                      {u.estimatedLatencyMs ? ` · ~${u.estimatedLatencyMs}ms` : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div style={cardStyle}>
            <strong>Company Employees ({data.agents.length})</strong>
            <div style={{ ...stackStyle, marginTop: '10px' }}>
              {data.agents.map((a) => (
                <div key={a.id} style={subCardStyle}>
                  <div style={betweenStyle}>
                    <div style={rowStyle}>
                      <strong>{a.name}</strong>
                      {a.title && <span style={mutedStyle}>{a.title}</span>}
                      {a.isEluvixAuto && <span style={badgeStyle}>eluvix/auto</span>}
                    </div>
                    <div style={mutedStyle}>
                      Open issues: {a.openIssueCount ?? 0} · Spent $
                      {((a.spentMonthlyCents || 0) / 100).toFixed(2)}
                      {a.budgetMonthlyCents
                        ? ` / $${(a.budgetMonthlyCents / 100).toFixed(2)}`
                        : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      <div style={{ ...cardStyle, ...stackStyle }}>
        <strong>Switchyard Route Explain Sandbox</strong>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={2}
          style={{
            width: '100%',
            padding: '8px',
            borderRadius: '8px',
            border: '1px solid var(--border)',
            background: 'transparent',
            color: 'inherit',
          }}
        />
        <div style={rowStyle}>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as any)}
            style={buttonStyle}
          >
            <option value="critical">Priority: critical</option>
            <option value="high">Priority: high</option>
            <option value="medium">Priority: medium</option>
            <option value="low">Priority: low</option>
          </select>
          <select
            value={sensitivity}
            onChange={(e) => setSensitivity(e.target.value as any)}
            style={buttonStyle}
          >
            <option value="public">Sensitivity: public</option>
            <option value="internal">Sensitivity: internal</option>
            <option value="confidential">Sensitivity: confidential</option>
          </select>
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={explaining}
            onClick={handleExplain}
          >
            {explaining ? 'Explaining…' : 'Dry-Run Explain'}
          </button>
        </div>
        {explainResult && (
          <div style={subCardStyle}>
            <div style={mutedStyle}>
              Upstream: <strong>{explainResult.upstreamId || explainResult.selectedUpstream || 'auto'}</strong> ·
              Tier: <strong>{explainResult.virtualTier || explainResult.requestedModel || 'eluvix/auto'}</strong>
            </div>
            {Array.isArray(explainResult.steps) && explainResult.steps.length > 0 && (
              <div style={{ ...mutedStyle, marginTop: '6px' }}>
                {explainResult.steps.map((s: any, i: number) => `${i + 1}. ${s.stage}: ${s.detail}`).join(' → ')}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function SwitchyardDashboardWidget({ context }: PluginWidgetProps) {
  const host = useHostContext();
  const nav = useHostNavigation();
  const companyId = context.companyId || host.companyId;
  const { data, loading } = usePluginData<DashboardOverviewData>(
    'eluvix:dashboard_overview',
    companyId ? { companyId } : undefined
  );

  const upstreams = data?.capabilities?.upstreams || [];
  const healthyCount = upstreams.filter((u) => u.healthy).length;
  const localCount = upstreams.filter((u) => u.isLocal).length;
  const targetPath = resolveSwitchyardPath(context);

  return (
    <div style={{ ...cardStyle, ...stackStyle }}>
      <div style={betweenStyle}>
        <strong>Switchyard Fleet</strong>
        <button type="button" style={buttonStyle} onClick={() => nav.navigate(targetPath)}>
          Open Switchyard
        </button>
      </div>
      {loading ? (
        <div style={mutedStyle}>Loading fleet…</div>
      ) : (
        <div style={rowStyle}>
          <span style={badgeStyle}>
            {healthyCount}/{upstreams.length} healthy
          </span>
          <span style={badgeStyle}>{localCount} local</span>
          <span style={badgeStyle}>{data?.pendingApprovals?.length || 0} pending approvals</span>
          <span style={badgeStyle}>mode: {data?.autoAssignMode || 'advisory'}</span>
        </div>
      )}
    </div>
  );
}

export function SwitchyardSidebarLink({ context }: PluginSidebarProps) {
  const nav = useHostNavigation();
  const targetPath = resolveSwitchyardPath(context);
  const props = nav.linkProps ? nav.linkProps(targetPath) : undefined;

  return (
    <a
      href={props?.href || targetPath}
      target={props?.target}
      rel={props?.rel}
      onClick={(event) => {
        if (props?.onClick) {
          props.onClick(event);
        } else {
          event.preventDefault();
          nav.navigate(targetPath);
        }
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 10px',
        borderRadius: '8px',
        color: 'inherit',
        textDecoration: 'none',
        fontSize: '13px',
      }}
    >
      <span>Switchyard</span>
    </a>
  );
}

export function AgentPerformancePanel({ context }: PluginDetailTabProps) {
  const host = useHostContext();
  const companyId = context.companyId || host.companyId;
  const agentId = context.entityId;
  const { data, loading, error, refresh } = usePluginData<AgentPerformanceData>(
    'eluvix:agent_performance',
    companyId && agentId ? { companyId, agentId } : undefined
  );

  if (!companyId || !agentId) return null;
  if (loading) return <div style={cardStyle}>Loading Eluvix agent performance…</div>;
  if (error) return <div style={cardStyle}>Error: {error.message}</div>;
  if (!data?.agent) return <div style={cardStyle}>Agent not found in Switchyard company scope.</div>;

  const a = data.agent;
  const rec = data.recommendation;

  return (
    <div style={{ ...cardStyle, ...stackStyle }}>
      <div style={betweenStyle}>
        <div style={rowStyle}>
          <strong>{a.name} — Switchyard Telemetry</strong>
          {a.model && <span style={badgeStyle}>{a.model}</span>}
          {a.status && <span style={badgeStyle}>{a.status}</span>}
        </div>
        <button type="button" style={buttonStyle} onClick={refresh}>
          Refresh
        </button>
      </div>
      <div style={rowStyle}>
        <span style={badgeStyle}>Open Issues: {a.openIssueCount ?? 0}</span>
        <span style={badgeStyle}>
          Monthly Spend: ${((a.spentMonthlyCents || 0) / 100).toFixed(2)}
          {a.budgetMonthlyCents ? ` / $${(a.budgetMonthlyCents / 100).toFixed(2)}` : ''}
        </span>
        {rec?.budgetForecast?.projectedDaysRemaining != null && (
          <span style={badgeStyle}>
            Budget Runway: ~{rec.budgetForecast.projectedDaysRemaining} days
          </span>
        )}
      </div>
      {rec?.breakdown && (
        <div style={subCardStyle}>
          <div style={rowStyle}>
            <span style={badgeStyle}>Fit {fmtPct(rec.breakdown.fit)}</span>
            <span style={badgeStyle}>Cost {fmtPct(rec.breakdown.cost)}</span>
            <span style={badgeStyle}>Latency {fmtPct(rec.breakdown.latency)}</span>
            <span style={badgeStyle}>Load {fmtPct(rec.breakdown.load)}</span>
            <span style={badgeStyle}>Budget {fmtPct(rec.breakdown.budget)}</span>
            <span style={badgeStyle}>History {fmtPct(rec.breakdown.history)}</span>
          </div>
          {rec.rationale && <div style={{ ...mutedStyle, marginTop: '6px' }}>{rec.rationale}</div>}
        </div>
      )}
      {data.excluded && (
        <div style={mutedStyle}>
          Currently excluded from delegation: {data.excluded.reasonCode} — {data.excluded.reason}
        </div>
      )}
    </div>
  );
}
