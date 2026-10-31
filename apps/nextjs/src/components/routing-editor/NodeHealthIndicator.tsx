import React from 'react';
import { useDockerStatus } from '../../hooks/useDockerStatus';

export default function NodeHealthIndicator({ serviceName }: { serviceName: string }) {
  const status = useDockerStatus(3000); // Poll every 3 seconds

  if (!status || !status.installed || !status.running) {
    return <div className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" title="Docker not running" />;
  }

  const service = status.services?.find(
    s =>
      s.name === serviceName ||
      s.container === serviceName ||
      s.name === serviceName.replace(/^eluvix-/, '') ||
      s.container === `eluvix-${serviceName}`
  );
  
  if (!service) {
    // If not found in docker services (e.g., cloud provider node), hide it
    return null;
  }

  const isHealthy = service.running && service.status === 'running';

  return (
    <div 
      className={`w-2.5 h-2.5 rounded-full shadow-md ${
        isHealthy 
          ? 'bg-emerald-500 shadow-emerald-500/50' 
          : 'bg-red-500 shadow-red-500/50 animate-pulse'
      }`} 
      title={isHealthy ? `${serviceName} container running` : `${serviceName} container offline`}
    />
  );
}
