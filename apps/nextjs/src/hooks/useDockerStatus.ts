import { useState, useEffect } from 'react';

export interface DockerServiceInfo {
  name: string;
  container: string;
  port: number;
  running: boolean;
  status: string;
}

export interface DockerStatusResponse {
  installed: boolean;
  running: boolean;
  version?: string;
  error?: string;
  services?: DockerServiceInfo[];
}

export function useDockerStatus(pollingInterval = 5000) {
  const [status, setStatus] = useState<DockerStatusResponse | null>(null);

  useEffect(() => {
    let mounted = true;
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/v1/docker/status');
        const data = await res.json();
        if (mounted) setStatus(data);
      } catch (err) {
        console.error('Failed to fetch Docker status:', err);
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, pollingInterval);
    
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [pollingInterval]);

  return status;
}
