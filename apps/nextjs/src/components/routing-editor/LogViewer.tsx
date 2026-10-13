import React, { useEffect, useState, useRef } from 'react';

interface LogViewerProps {
  containerName: string | null;
  onClose: () => void;
}

export default function LogViewer({ containerName, onClose }: LogViewerProps) {
  const [logs, setLogs] = useState<string[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerName) {
      setLogs([]);
      return;
    }

    setLogs([`Connecting to log stream for ${containerName}...`]);
    const eventSource = new EventSource(`/api/v1/docker/logs?container=${containerName}`);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setLogs((prev) => [...prev, data]);
      } catch {
        setLogs((prev) => [...prev, event.data]);
      }
    };

    eventSource.onerror = (error) => {
      console.error('SSE Error', error);
      setLogs((prev) => [...prev, `[Connection closed or errored]`]);
      eventSource.close();
    };

    return () => {
      eventSource.close();
    };
  }, [containerName]);

  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  if (!containerName) return null;

  return (
    <div className="fixed bottom-0 left-0 w-full h-64 bg-gray-950/95 border-t border-gray-800 shadow-2xl font-mono text-xs text-gray-300 z-50 flex flex-col backdrop-blur-sm">
      <div className="flex items-center justify-between px-4 py-2 bg-gray-900 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
          <span className="font-bold text-gray-200">Container Logs: {containerName}</span>
        </div>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 rounded px-2 py-0.5 transition"
        >
          Close
        </button>
      </div>
      
      <div className="flex-1 overflow-y-auto p-4 space-y-1">
        {logs.map((log, i) => (
          <div key={i} className="whitespace-pre-wrap break-all leading-relaxed">
            {log}
          </div>
        ))}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}
