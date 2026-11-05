export interface TargetSystem {
  id: string;
  name: string;
  baseUrl: string;
  description?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OperationRecord {
  id: string;
  name: string;
  systemId: string;
  targetUrl: string;
  description?: string;
  steps: number;
  nodes: number;
  status: "draft" | "ready";
  createdAt: string;
  updatedAt: string;
}

export interface FlowItem {
  id: string;
  name: string;
  description?: string;
  recordCount: number;
  status: "draft" | "ready";
  createdAt: string;
  updatedAt: string;
}
