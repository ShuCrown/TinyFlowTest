import { useMemo, useState, type FormEvent } from "react";
import { Pencil, Plus, Save, Trash2, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Dialog, EmptyState, Field, PageHeader, StatCard } from "../components/ui";
import {
  deleteSystem,
  formatTime,
  getSystemToken,
  listRecords,
  listSystems,
  newId,
  saveSystem,
  saveSystemToken,
} from "../lib/store";
import type { OperationRecord, TargetSystem } from "../lib/types";

type SystemDraft = Pick<TargetSystem, "name" | "baseUrl" | "description" | "enabled"> & {
  token?: string;
};

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function SystemDialog({
  system,
  onClose,
  onSave,
}: {
  system: TargetSystem | null;
  onClose: () => void;
  onSave: (draft: SystemDraft) => void;
}) {
  const [name, setName] = useState(system?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(system?.baseUrl ?? "");
  const [token, setToken] = useState(() => (system ? getSystemToken(system.id) : ""));
  const [showToken, setShowToken] = useState(false);
  const [description, setDescription] = useState(system?.description ?? "");
  const [enabled, setEnabled] = useState(system?.enabled ?? true);
  const [error, setError] = useState("");

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const nextName = name.trim();
    const nextUrl = baseUrl.trim();
    if (!nextName) {
      setError("请填写系统名称。");
      return;
    }
    if (!isHttpUrl(nextUrl)) {
      setError("目标地址需要是完整的 http(s) 地址，例如 http://dev.example.com/dashboard。");
      return;
    }
    setError("");
    onSave({
      name: nextName,
      baseUrl: nextUrl.replace(/\/$/, ""),
      token: token.trim() || undefined,
      description: description.trim() || undefined,
      enabled,
    });
  };

  return (
    <Dialog
      open
      title={system ? "编辑系统" : "新增系统"}
      description="系统地址会在录制与回放时作为同源代理目标使用；Token 可选，只保存在当前标签页。"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            <X />
            取消
          </Button>
          <Button variant="default" type="submit" form="system-form">
            <Save />
            保存系统
          </Button>
        </>
      }
    >
      <form id="system-form" className="grid gap-4" onSubmit={submit}>
        <Field label="系统名称">
          <input
            className="tf-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：客户中心"
            autoFocus
          />
        </Field>
        <Field
          label="目标地址"
          hint="建议填写系统首页或登录后的落地页；后续录制会打开这个地址。"
        >
          <input
            className="tf-input font-mono text-[12px]"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="http://dev.example.com/dashboard"
            spellCheck={false}
          />
        </Field>
        <Field
          label="登录 Token（可选）"
          hint="只存当前标签页的 sessionStorage，刷新仍在、关闭标签页即清除；不会写入系统配置的 localStorage。"
        >
          <div className="relative">
            <input
              id="system-token"
              className="tf-input pr-14 font-mono text-[12px]"
              type={showToken ? "text" : "password"}
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="Bearer token / access_token"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 font-mono text-[10px] text-muted transition-colors hover:text-ink"
              onClick={() => setShowToken((visible) => !visible)}
            >
              {showToken ? "隐藏" : "显示"}
            </button>
          </div>
        </Field>
        <Field label="说明（可选）">
          <textarea
            className="tf-textarea"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="这个系统主要覆盖哪些业务操作？"
          />
        </Field>
        <label className="flex items-center gap-2 text-[12.5px] text-ink">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="h-4 w-4 accent-[var(--color-accent)]"
          />
          启用该系统
        </label>
        {error ? (
          <p className="rounded-lg border border-danger/20 bg-[#fdf3f0] px-3 py-2 text-[12px] leading-5 text-danger">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}

export function SystemsPage() {
  const [systems, setSystems] = useState<TargetSystem[]>(() => listSystems());
  const [records] = useState<OperationRecord[]>(() => listRecords());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<TargetSystem | null>(null);

  const recordCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const record of records) {
      counts.set(record.systemId, (counts.get(record.systemId) ?? 0) + 1);
    }
    return counts;
  }, [records]);

  const enabledCount = systems.filter((system) => system.enabled).length;
  const linkedRecords = records.filter((record) =>
    systems.some((system) => system.id === record.systemId),
  ).length;
  const lastUpdated = systems[0] ? new Date(systems[0].updatedAt).toLocaleDateString("zh-CN") : "—";

  const sessionTokens = useMemo(() => {
    const tokens = new Map<string, boolean>();
    for (const system of systems) tokens.set(system.id, Boolean(getSystemToken(system.id)));
    return tokens;
  }, [systems]);
  const tokenCount = systems.filter((system) => sessionTokens.get(system.id)).length;

  const openCreate = (): void => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (system: TargetSystem): void => {
    setEditing(system);
    setDialogOpen(true);
  };

  const handleSave = (draft: SystemDraft): void => {
    const now = new Date().toISOString();
    const { token, ...meta } = draft;
    const next: TargetSystem = editing
      ? { ...editing, ...meta, updatedAt: now }
      : { ...meta, id: newId("sys"), createdAt: now, updatedAt: now };
    saveSystem(next);
    saveSystemToken(next.id, token);
    setSystems(listSystems());
    setEditing(null);
    setDialogOpen(false);
  };

  const handleDelete = (system: TargetSystem): void => {
    if (!window.confirm(`删除系统「${system.name}」？已绑定的操作记录不会被删除。`)) return;
    deleteSystem(system.id);
    setSystems(listSystems());
  };

  return (
    <div className="pb-10">
      <PageHeader
        code="SYS / SYSTEMS"
        title="系统管理"
        description="维护被测系统的名称、目标地址与登录 Token。Token 仅保存在当前标签页的 sessionStorage，关闭标签页即清除；系统元数据仍按 localStorage 保存。"
        actions={
          <Button variant="default" onClick={openCreate}>
            <Plus />
            新增系统
          </Button>
        }
      />

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="SYSTEMS" value={systems.length} hint="已登记的被测系统" tone="accent" />
        <StatCard label="ENABLED" value={enabledCount} hint="当前启用" tone="moss" />
        <StatCard label="RECORDS" value={linkedRecords} hint="绑定到系统的操作记录" />
        <StatCard label="UPDATED" value={lastUpdated} hint="最近一次系统配置更新" tone="amber" />
      </div>

      {systems.length === 0 ? (
        <div className="mt-5">
          <EmptyState
            code="SYS"
            title="还没有系统"
            description="先登记一个目标系统，后续新增操作记录时就能直接选择它。"
            action={
              <Button variant="default" onClick={openCreate}>
                <Plus />
                新增第一个系统
              </Button>
            }
          />
        </div>
      ) : (
        <Card className="mt-5 gap-0 overflow-hidden">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 border-b border-line px-4 py-3">
            <div className="flex items-center gap-2">
              <CardTitle>系统清单</CardTitle>
              <Badge variant="secondary">{systems.length}</Badge>
              <Badge variant={tokenCount ? "moss" : "secondary"}>
                Token {tokenCount}/{systems.length}
              </Badge>
            </div>
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
              meta · localStorage / token · sessionStorage
            </span>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>系统</TableHead>
                  <TableHead>目标地址</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>Token</TableHead>
                  <TableHead>关联记录</TableHead>
                  <TableHead>更新时间</TableHead>
                  <TableHead className="w-[1%] whitespace-nowrap text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {systems.map((system) => (
                  <TableRow key={system.id}>
                    <TableCell>
                      <div className="font-semibold">{system.name}</div>
                      {system.description ? (
                        <div className="mt-0.5 line-clamp-1 text-[11.5px] text-muted">
                          {system.description}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="max-w-[320px]">
                      <div className="truncate font-mono text-[11.5px] text-muted" title={system.baseUrl}>
                        {system.baseUrl}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={system.enabled ? "moss" : "secondary"}>
                        {system.enabled ? "启用" : "停用"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={sessionTokens.get(system.id) ? "moss" : "secondary"}>
                        {sessionTokens.get(system.id) ? "本会话" : "未配置"}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-[12px]">
                      {recordCounts.get(system.id) ?? 0}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-[12px] text-muted">
                      {formatTime(system.updatedAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1.5">
                        <Button size="sm" variant="outline" onClick={() => openEdit(system)}>
                          <Pencil className="size-3.5" />
                          编辑
                        </Button>
                        <Button size="sm" variant="destructive" onClick={() => handleDelete(system)}>
                          <Trash2 className="size-3.5" />
                          删除
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {dialogOpen ? (
        <SystemDialog
          key={editing?.id ?? "new"}
          system={editing}
          onClose={() => {
            setDialogOpen(false);
            setEditing(null);
          }}
          onSave={handleSave}
        />
      ) : null}
    </div>
  );
}
