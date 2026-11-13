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
  composeVersion?: string;
  error?: string;
  services?: DockerServiceInfo[];
  dockerAvailable?: boolean;
  containers?: string[];
  topologyServices?: string[];
  message?: string;
}

let cachedStatus: DockerStatusResponse | null = null;
const subscribers: Set<(status: DockerStatusResponse | null) => void> = new Set();
let pollTimer: NodeJS.Timeout | null = null;
let activeInterval = 5000;

async function fetchStatus() {
  try {
    const res = await fetch('/api/v1/docker/status');
    const data = await res.json();
    cachedStatus = {
      ...data,
      dockerAvailable: data.dockerAvailable ?? data.running,
      containers: data.containers ?? data.services?.filter((s: any) => s.running).map((s: any) => s.container) ?? [],
    };
    subscribers.forEach(sub => sub(cachedStatus));
  } catch (err) {
    console.error('Failed to fetch Docker status:', err);
  }
}

function startPolling(intervalMs: number) {
  if (pollTimer) clearInterval(pollTimer);
  activeInterval = Math.min(activeInterval, intervalMs);
  pollTimer = setInterval(fetchStatus, activeInterval);
  fetchStatus();
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function useDockerStatus(pollingInterval = 5000) {
  const [status, setStatus] = useState<DockerStatusResponse | null>(cachedStatus);

  useEffect(() => {
    subscribers.add(setStatus);
    let timer: NodeJS.Timeout | undefined;
    if (subscribers.size === 1) {
      startPolling(pollingInterval);
    } else if (cachedStatus) {
      // Adopt the latest cached status, which may have advanced since this
      // component's initial render. Deferred to a timer callback so the
      // effect body sets no state synchronously
      // (react-hooks/set-state-in-effect); the subscriber added above still
      // receives live poll updates in the meantime.
      timer = setTimeout(() => setStatus(cachedStatus), 0);
    }

    return () => {
      if (timer !== undefined) clearTimeout(timer);
      subscribers.delete(setStatus);
      if (subscribers.size === 0) {
        stopPolling();
      }
    };
  }, [pollingInterval]);

  return status;
}
