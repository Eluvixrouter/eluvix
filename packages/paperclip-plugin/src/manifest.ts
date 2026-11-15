export const ELUVIX_PLUGIN_ID = 'eluvix.switchyard';

export const manifest = {
  id: ELUVIX_PLUGIN_ID,
  name: 'Eluvix Switchyard',
  version: '1.3.0',
  apiVersion: 1,
  description:
    'Switchyard fleet visibility, ranked task-to-employee delegation recommendations, opt-in auto-assignment, and outcome feedback.',
  capabilities: [
    'companies.read',
    'agents.read',
    'issues.read',
    'issue.comments.read',
    'goals.read',
    'costs.read',
    'issue.comments.create',
    'issues.update',
    'activity.log.write',
    'events.subscribe',
    'http.outbound',
    'secrets.read-ref',
    'plugin.state.read',
    'plugin.state.write',
    'jobs.schedule',
    'skills.managed',
    'agent.tools.register',
    'instance.settings.register',
    'ui.page.register',
    'ui.sidebar.register',
    'ui.dashboardWidget.register',
    'ui.detailTab.register',
    'ui.commentAnnotation.register',
    'ui.action.register',
  ],
  tools: [
    {
      name: 'eluvix:capabilities',
      displayName: 'Eluvix Switchyard Capabilities',
      description:
        'Inspect active Eluvix upstreams, virtual tier models, modalities, local/cloud egress class, health, and cost per 1k tokens.',
      parametersSchema: { type: 'object', properties: {} },
    },
    {
      name: 'eluvix:classify_task',
      displayName: 'Classify Task via Switchyard',
      description:
        'Classify a Paperclip issue or prompt into modality, complexity, sensitivity, and suggested Switchyard tier.',
      parametersSchema: {
        type: 'object',
        properties: {
          issueId: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          labels: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    {
      name: 'eluvix:recommend_assignee',
      displayName: 'Recommend Employee Assignee',
      description:
        'Rank company employees for a Paperclip issue using Switchyard capability fit, cost, latency, load, budget headroom, and sensitivity.',
      parametersSchema: {
        type: 'object',
        properties: {
          issueId: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          labels: { type: 'array', items: { type: 'string' } },
          candidateAgentIds: { type: 'array', items: { type: 'string' } },
          topN: { type: 'number' },
        },
      },
    },
    {
      name: 'eluvix:explain_route',
      displayName: 'Explain Switchyard Route',
      description:
        'Dry-run Eluvix Switchyard routing for a sample prompt with optional Paperclip priority and sensitivity.',
      parametersSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          model: { type: 'string' },
          priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          sensitivity: { type: 'string', enum: ['public', 'internal', 'confidential'] },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'eluvix:budget',
      displayName: 'Inspect Eluvix & Agent Budget',
      description: 'Inspect Eluvix rolling 24h spend, daily cap, and caller agent budget headroom.',
      parametersSchema: { type: 'object', properties: {} },
    },
  ],
  ui: {
    slots: [
      {
        type: 'taskDetailView',
        id: 'eluvix-issue-recommendation',
        displayName: 'Eluvix Switchyard Routing',
        exportName: 'IssueRecommendationCard',
        entityTypes: ['issue'],
      },
      {
        type: 'page',
        id: 'eluvix-switchyard-page',
        displayName: 'Switchyard Fleet',
        exportName: 'SwitchyardDashboardPage',
        routePath: 'switchyard',
      },
      {
        type: 'dashboardWidget',
        id: 'switchyard-fleet',
        displayName: 'Switchyard Fleet',
        exportName: 'SwitchyardDashboardWidget',
      },
      {
        type: 'sidebar',
        id: 'eluvix-switchyard-sidebar',
        displayName: 'Switchyard',
        exportName: 'SwitchyardSidebarLink',
        routePath: 'switchyard',
      },
      {
        type: 'detailTab',
        id: 'eluvix-agent-tab',
        displayName: 'Eluvix Performance',
        exportName: 'AgentPerformancePanel',
        entityTypes: ['agent'],
      },
    ],
  },
} as const;

export default manifest;
