import React from 'react';
import { useDockerStatus } from '../../hooks/useDockerStatus';

export interface NodeLiveTelemetry {
  requests: number;
  avgLatencyMs: number;
  p95LatencyMs?: number;
  hitSharePct: number;
  activeRecently?: boolean;
}

export default function NodeHealthIndicator({
  serviceName,
  liveTelemetry,
}: {
  serviceName: string;
  liveTelemetry?: NodeLiveTelemetry;
}) {
  const status = useDockerStatus(3000); // Poll every 3 seconds

  const telemetryBadge = liveTelemetry && liveTelemetry.requests > 0 ? (
    <span
      className="px-1.5 py-0.2 rounded bg-sky-950/90 border border-sky-500/50 text-[9px] font-mono text-sky-300 whitespace-nowrap"
      title={`Routed ${liveTelemetry.requests} req(s) • Avg ${liveTelemetry.avgLatencyMs}ms • Share ${liveTelemetry.hitSharePct}%`}
    >
      ⚡ {liveTelemetry.avgLatencyMs}ms • {liveTelemetry.hitSharePct}%
    </span>
  ) : null;

  if (!status || !status.installed || !status.running) {
    return (
      <div className="flex items-center gap-1">
        <div className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" title="Docker not running" />
        {telemetryBadge}
      </div>
    );
  }

  const service = status.services?.find(
    s =>
      s.name === serviceName ||
      s.container === serviceName ||
      s.name === serviceName.replace(/^eluvix-/, '') ||
      s.container === `eluvix-${serviceName}`
  );
  
  if (!service) {
    // If not found in docker services (e.g., cloud provider node), still render telemetry badge if present
    return telemetryBadge;
  }

  const isHealthy = service.running && service.status === 'running';

  return (
    <div className="flex items-center gap-1">
      <div 
        className={`w-2.5 h-2.5 rounded-full shadow-md ${
          isHealthy 
            ? 'bg-emerald-500 shadow-emerald-500/50' 
            : 'bg-red-500 shadow-red-500/50 animate-pulse'
        }`} 
        title={isHealthy ? `${serviceName} container running` : `${serviceName} container offline`}
      />
      {telemetryBadge}
    </div>
  );
}
