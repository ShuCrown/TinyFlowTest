import { useMemo, useState, type FormEvent } from "react";
import { Pencil, Plus, Save, Server, Trash2, TriangleAlert, X } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, Field, ItemCard, PageHeader } from "../components/ui";
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

type SystemDraft = Pick<TargetSystem, "name" | "baseUrl" | "description"> & {
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
      setError("目标地址需要是完整的网址，例如 http://dev.example.com/dashboard。");
      return;
    }
    setError("");
    onSave({
      name: nextName,
      baseUrl: nextUrl.replace(/\/$/, ""),
      token: token.trim() || undefined,
      description: description.trim() || undefined,
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Server className="size-4 text-accent" />
            {system ? "编辑系统" : "新增系统"}
          </DialogTitle>
          <DialogDescription>
            系统地址会在录制与回放时经开发期代理加载，可填写任意 http(s) 系统；登录令牌可选，只保存在当前标签页。
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <form id="system-form" className="grid gap-4" onSubmit={submit}>
            <Field label="系统名称" htmlFor="system-name">
              <Input
                id="system-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：客户中心"
                autoFocus
              />
            </Field>
            <Field
              label="目标地址"
              htmlFor="system-url"
              hint="建议填写系统首页或登录后的落地页；后续录制会打开这个地址。"
            >
              <Input
                id="system-url"
                className="font-mono text-[12px]"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="http://dev.example.com/dashboard"
                spellCheck={false}
              />
            </Field>
            <Field
              label="登录令牌（可选）"
              htmlFor="system-token"
              hint="只保存在当前标签页的会话存储，刷新仍在、关闭标签页即清除；不会写入系统配置的本地存储。"
            >
              <div className="relative">
                <Input
                  id="system-token"
                  className="pr-14 font-mono text-[12px]"
                  type={showToken ? "text" : "password"}
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="粘贴登录令牌"
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
            <Field label="说明（可选）" htmlFor="system-description">
              <Textarea
                id="system-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="这个系统主要覆盖哪些业务操作？"
              />
            </Field>
            {error ? (
              <div className="flex items-start gap-2 rounded-lg border border-danger/20 bg-danger-soft px-3 py-2 text-[12px] leading-5 text-danger">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>{error}</span>
              </div>
            ) : null}
          </form>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            <X />
            取消
          </Button>
          <Button type="submit" form="system-form">
            <Save />
            保存系统
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SystemsPage() {
  const [systems, setSystems] = useState<TargetSystem[]>(() => listSystems());
  const [records] = useState<OperationRecord[]>(() => listRecords());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<TargetSystem | null>(null);
  const [deleting, setDeleting] = useState<TargetSystem | null>(null);

  const recordCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const record of records) {
      counts.set(record.systemId, (counts.get(record.systemId) ?? 0) + 1);
    }
    return counts;
  }, [records]);

  const sessionTokens = useMemo(() => {
    const tokens = new Map<string, boolean>();
    for (const system of systems) tokens.set(system.id, Boolean(getSystemToken(system.id)));
    return tokens;
  }, [systems]);

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

  const confirmDelete = (): void => {
    if (!deleting) return;
    deleteSystem(deleting.id);
    setSystems(listSystems());
    setDeleting(null);
  };

  return (
    <div className="flex flex-col gap-4 pb-10">
      <PageHeader
        icon={<Server className="size-6 text-accent shrink-0" />}
        title="系统管理"
        description="维护被测系统的名称、目标地址与登录令牌。令牌仅保存在当前标签页的会话存储，关闭标签页即清除；系统资料仍保存在本地存储。"
        actions={
          <Button size="sm" variant="default" onClick={openCreate}>
            <Plus />
            新增系统
          </Button>
        }
      />

      {systems.length === 0 ? (
        <EmptyState
          icon={<Server className="size-5" />}
          code="SYS"
          title="还没有系统"
          description="先登记一个目标系统，后续新增操作记录时就能直接选择它。"
          action={
            <Button size="sm" variant="default" onClick={openCreate}>
              <Plus />
              新增第一个系统
            </Button>
          }
        />
      ) : (
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {systems.map((system) => (
            <ItemCard
              key={system.id}
              code={`系统-${system.id.slice(-4).toUpperCase()}`}
              icon={<Server className="size-4 shrink-0 text-accent" />}
              title={system.name}
              actions={
                <>
                  <Button size="sm" variant="outline" onClick={() => openEdit(system)}>
                    <Pencil className="size-3.5" />
                    编辑
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => setDeleting(system)}>
                    <Trash2 className="size-3.5" />
                    删除
                  </Button>
                </>
              }
            >
              <div className="truncate font-mono text-[11px]" title={system.baseUrl}>
                {system.baseUrl}
              </div>
              {system.description ? <div className="line-clamp-1">{system.description}</div> : null}
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant={sessionTokens.get(system.id) ? "moss" : "secondary"}>
                  {sessionTokens.get(system.id) ? "令牌已配置" : "令牌未配置"}
                </Badge>
                <span>关联 {recordCounts.get(system.id) ?? 0} 条</span>
              </div>
              <div>{formatTime(system.updatedAt)}</div>
            </ItemCard>
          ))}
        </section>
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

      <AlertDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TriangleAlert className="size-4 text-danger" />
              删除这个系统？
            </AlertDialogTitle>
            <AlertDialogDescription>
              「{deleting?.name}」会从当前浏览器移除，已绑定的操作记录不会被删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <X />
              取消
            </AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>
              <Trash2 />
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
