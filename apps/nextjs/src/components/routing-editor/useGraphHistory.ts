"use client";

import { useState, useCallback, useEffect, useRef } from 'react';
import type { Node, Edge } from '@xyflow/react';

export interface GraphHistoryEntry {
  nodes: Node[];
  edges: Edge[];
  label: string;
  fingerprint: string;
}

const MAX_HISTORY_ENTRIES = 50;

function stripEphemeralNodeFields(data: any): Record<string, any> {
  if (!data || typeof data !== 'object') return {};
  const copy = { ...data };
  delete copy.status;
  delete copy.models;
  delete copy.modelDetails;
  delete copy.liveTelemetry;
  return copy;
}

export function computeHistoryFingerprint(nodes: Node[], edges: Edge[]): string {
  return JSON.stringify({
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type,
      x: Math.round(n.position?.x ?? 0),
      y: Math.round(n.position?.y ?? 0),
      data: stripEphemeralNodeFields(n.data),
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? null,
      targetHandle: e.targetHandle ?? null,
    })),
  });
}

function cloneGraph(nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: nodes.map((n) => ({
      ...n,
      position: { x: n.position.x, y: n.position.y },
      data: n.data && typeof n.data === 'object' ? JSON.parse(JSON.stringify(stripEphemeralNodeFields(n.data))) : n.data,
    })),
    edges: edges.map((e) => ({
      ...e,
      style: e.style ? { ...e.style } : undefined,
    })),
  };
}

/**
 * Bounded 50-entry Undo/Redo history stack for the Eluvix Visual Node Routing Editor.
 * Ignores ephemeral health/model probe mutations so Undo always steps through
 * meaningful user edits (node add/delete, drag, wire, auto-layout, auto-fix).
 */
export function useGraphHistory() {
  const [past, setPast] = useState<GraphHistoryEntry[]>([]);
  const [future, setFuture] = useState<GraphHistoryEntry[]>([]);
  const pastRef = useRef<GraphHistoryEntry[]>([]);
  const futureRef = useRef<GraphHistoryEntry[]>([]);

  // Keep the refs mirroring state after render, not during it
  // (react-hooks/refs). The stable callbacks below read the latest stacks
  // through these refs; effects flush before event handlers run, so the
  // refs are always current when a callback fires.
  useEffect(() => {
    pastRef.current = past;
    futureRef.current = future;
  });

  const recordSnapshot = useCallback((nodes: Node[], edges: Edge[], label = 'Edit graph') => {
    const fingerprint = computeHistoryFingerprint(nodes, edges);
    const prevTop = pastRef.current[pastRef.current.length - 1];
    if (prevTop && prevTop.fingerprint === fingerprint) {
      return;
    }
    const cloned = cloneGraph(nodes, edges);
    const entry: GraphHistoryEntry = {
      nodes: cloned.nodes,
      edges: cloned.edges,
      label,
      fingerprint,
    };
    setPast((prev) => {
      const next = [...prev, entry];
      return next.length > MAX_HISTORY_ENTRIES ? next.slice(next.length - MAX_HISTORY_ENTRIES) : next;
    });
    setFuture([]);
  }, []);

  const resetHistory = useCallback(() => {
    setPast([]);
    setFuture([]);
  }, []);

  const undo = useCallback(
    (
      currentNodes: Node[],
      currentEdges: Edge[]
    ): { nodes: Node[]; edges: Edge[]; label: string } | null => {
      if (pastRef.current.length === 0) return null;
      const target = pastRef.current[pastRef.current.length - 1];
      const currentCloned = cloneGraph(currentNodes, currentEdges);
      const currentEntry: GraphHistoryEntry = {
        nodes: currentCloned.nodes,
        edges: currentCloned.edges,
        label: target.label,
        fingerprint: computeHistoryFingerprint(currentNodes, currentEdges),
      };

      setPast((prev) => prev.slice(0, -1));
      setFuture((prev) =>
        [currentEntry, ...prev].slice(0, MAX_HISTORY_ENTRIES)
      );

      const restored = cloneGraph(target.nodes, target.edges);
      return {
        nodes: restored.nodes,
        edges: restored.edges,
        label: target.label,
      };
    },
    []
  );

  const redo = useCallback(
    (
      currentNodes: Node[],
      currentEdges: Edge[]
    ): { nodes: Node[]; edges: Edge[]; label: string } | null => {
      if (futureRef.current.length === 0) return null;
      const target = futureRef.current[0];
      const currentCloned = cloneGraph(currentNodes, currentEdges);
      const currentEntry: GraphHistoryEntry = {
        nodes: currentCloned.nodes,
        edges: currentCloned.edges,
        label: target.label,
        fingerprint: computeHistoryFingerprint(currentNodes, currentEdges),
      };

      setFuture((prev) => prev.slice(1));
      setPast((prev) => {
        const next = [...prev, currentEntry];
        return next.length > MAX_HISTORY_ENTRIES ? next.slice(next.length - MAX_HISTORY_ENTRIES) : next;
      });

      const restored = cloneGraph(target.nodes, target.edges);
      return {
        nodes: restored.nodes,
        edges: restored.edges,
        label: target.label,
      };
    },
    []
  );

  return {
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    undoLabel: past[past.length - 1]?.label ?? null,
    redoLabel: future[0]?.label ?? null,
    historyDepth: past.length,
    futureDepth: future.length,
    recordSnapshot,
    resetHistory,
    undo,
    redo,
  };
}
