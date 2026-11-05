import type { FlowItem, OperationRecord, TargetSystem } from "./types";

const SYSTEMS_KEY = "tinyflowtest:systems:v1";
const RECORDS_KEY = "tinyflowtest:records:v1";
const FLOWS_KEY = "tinyflowtest:flows:v1";
const SYSTEM_TOKEN_PREFIX = "tinyflowtest:system-token:";

function systemTokenKey(systemId: string): string {
  return `${SYSTEM_TOKEN_PREFIX}${systemId}`;
}

/** Token 只放 sessionStorage：刷新仍在，关闭标签页即清除；系统元数据仍存 localStorage。 */
export function getSystemToken(systemId: string): string {
  try {
    return sessionStorage.getItem(systemTokenKey(systemId)) ?? "";
  } catch {
    return "";
  }
}

export function saveSystemToken(systemId: string, token?: string): void {
  try {
    const clean = token?.trim() ?? "";
    if (clean) sessionStorage.setItem(systemTokenKey(systemId), clean);
    else sessionStorage.removeItem(systemTokenKey(systemId));
  } catch {
    // sessionStorage 不可用时静默跳过，不阻塞系统配置保存。
  }
}

export function deleteSystemToken(systemId: string): void {
  try {
    sessionStorage.removeItem(systemTokenKey(systemId));
  } catch {
    // ignore
  }
}

function readList<T>(key: string): T[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function writeList<T>(key: string, items: T[]): void {
  localStorage.setItem(key, JSON.stringify(items));
}

function byUpdatedDesc<T extends { updatedAt: string }>(a: T, b: T): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function formatTime(iso?: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", { hour12: false });
}

export function listSystems(): TargetSystem[] {
  return readList<TargetSystem>(SYSTEMS_KEY).sort(byUpdatedDesc);
}

export function saveSystem(system: TargetSystem): void {
  const items = readList<TargetSystem>(SYSTEMS_KEY);
  const index = items.findIndex((item) => item.id === system.id);
  if (index >= 0) items[index] = system;
  else items.unshift(system);
  writeList(SYSTEMS_KEY, items);
}

export function deleteSystem(id: string): void {
  writeList(
    SYSTEMS_KEY,
    readList<TargetSystem>(SYSTEMS_KEY).filter((item) => item.id !== id),
  );
  deleteSystemToken(id);
}

export function listRecords(): OperationRecord[] {
  return readList<OperationRecord>(RECORDS_KEY).sort(byUpdatedDesc);
}

export function saveRecord(record: OperationRecord): void {
  const items = readList<OperationRecord>(RECORDS_KEY);
  const index = items.findIndex((item) => item.id === record.id);
  if (index >= 0) items[index] = record;
  else items.unshift(record);
  writeList(RECORDS_KEY, items);
}

export function deleteRecord(id: string): void {
  writeList(
    RECORDS_KEY,
    readList<OperationRecord>(RECORDS_KEY).filter((item) => item.id !== id),
  );
}

export function listFlows(): FlowItem[] {
  return readList<FlowItem>(FLOWS_KEY).sort(byUpdatedDesc);
}

export function saveFlow(flow: FlowItem): void {
  const items = readList<FlowItem>(FLOWS_KEY);
  const index = items.findIndex((item) => item.id === flow.id);
  if (index >= 0) items[index] = flow;
  else items.unshift(flow);
  writeList(FLOWS_KEY, items);
}

export function deleteFlow(id: string): void {
  writeList(
    FLOWS_KEY,
    readList<FlowItem>(FLOWS_KEY).filter((item) => item.id !== id),
  );
}
