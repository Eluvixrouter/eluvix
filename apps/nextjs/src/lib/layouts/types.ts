export interface LayoutViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface LayoutMetadata {
  id: string; // slug, e.g. "cost-cascade"
  name: string;
  description?: string;
  category?: 'starter' | 'local' | 'hybrid' | 'cost' | 'privacy' | 'agent' | 'custom' | string;
  tags?: string[];
  isExample?: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
  edgeCount: number;
}

export interface Layout {
  id: string; // slug
  name: string;
  description?: string;
  category?: 'starter' | 'local' | 'hybrid' | 'cost' | 'privacy' | 'agent' | 'custom' | string;
  tags?: string[];
  isExample?: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  viewport?: LayoutViewport;
  nodes: any[];
  edges: any[];
}

export interface LayoutsState {
  lastActiveSlug?: string;
  examplesSeededVersion?: number;
}
