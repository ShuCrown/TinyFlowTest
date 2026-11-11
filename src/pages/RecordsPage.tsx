import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { MonitorDot, Pencil, Plus, Save, Trash2, TriangleAlert, X } from "lucide-react";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { deleteRecord, formatTime, listRecords, listSystems, newId, saveRecord } from "@/lib/store";
import type { OperationRecord, TargetSystem } from "@/lib/types";
import { EmptyState, Field, ItemCard, PageHeader } from "../components/ui";

type RecordDraft = Pick<OperationRecord, "name" | "systemId" | "targetUrl" | "description">;

const NO_SYSTEM = "none";

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isTargetUrl(value: string): boolean {
  const clean = value.trim();
  return clean.startsWith("/") || isHttpUrl(clean);
}

function RecordDialog({
  record,
  systems,
  onClose,
  onSave,
}: {
  record: OperationRecord | null;
  systems: TargetSystem[];
  onClose: () => void;
  onSave: (draft: RecordDraft) => void;
}) {
  const initialSystem = record?.systemId ?? systems[0]?.id ?? "";
  const initialSystemConfig = systems.find((system) => system.id === initialSystem);
  const [name, setName] = useState(record?.name ?? "");
  const [systemId, setSystemId] = useState(initialSystem);
  const [targetUrl, setTargetUrl] = useState(record?.targetUrl ?? initialSystemConfig?.baseUrl ?? "");
  const [description, setDescription] = useState(record?.description ?? "");
  const [error, setError] = useState("");

  const selectSystem = (nextId: string): void => {
    setSystemId(nextId);
    const system = systems.find((item) => item.id === nextId);
    if (system) setTargetUrl(system.baseUrl);
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!name.trim()) {
      setError("请填写记录名称。");
      return;
    }
    if (!isTargetUrl(targetUrl.trim())) {
      setError("目标地址需要是完整的 http(s) 地址，或以 / 开头的同源路径。");
      return;
    }
    setError("");
    onSave({
      name: name.trim(),
      systemId,
      targetUrl: targetUrl.trim().replace(/\/$/, ""),
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
            <MonitorDot className="size-4 text-accent" />
            {record ? "编辑记录" : "新增记录"}
          </DialogTitle>
          <DialogDescription>
            记录是一次操作录制的容器；录制 JSON、转换后的 DSL 与回放微调值都会挂在记录下。
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <form id="record-form" className="grid gap-4" onSubmit={submit}>
            <Field label="记录名称" htmlFor="record-name">
              <Input
                id="record-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：新建客户"
                autoFocus
              />
            </Field>

            <Field
              label="所属系统"
              htmlFor="record-system"
              hint={
                systems.length === 0 ? (
                  <>
                    还没有系统，先到{" "}
                    <Link className="text-accent underline underline-offset-2" to="/systems">
                      系统管理
                    </Link>{" "}
                    添加，或直接填写目标地址。
                  </>
                ) : (
                  "选择系统后会自动带入目标地址，仍可手动修改。"
                )
              }
            >
              <Select
                value={systemId || NO_SYSTEM}
                onValueChange={(value) => selectSystem(value === NO_SYSTEM ? "" : value)}
              >
                <SelectTrigger id="record-system">
                  <SelectValue placeholder="不绑定系统" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_SYSTEM}>不绑定系统</SelectItem>
                  {systems.map((system) => (
                    <SelectItem key={system.id} value={system.id}>
                      {system.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field
              label="目标地址"
              htmlFor="record-url"
              hint={
                <>
                  可使用同源路径（如 <span className="font-mono">/tf/demo/customers.html</span>）
                  直接录制；跨域系统需与开发期代理目标一致。
                </>
              }
            >
              <Input
                id="record-url"
                className="font-mono text-[12px]"
                value={targetUrl}
                onChange={(event) => setTargetUrl(event.target.value)}
                placeholder="http://dev.example.com/dashboard"
                spellCheck={false}
              />
            </Field>

            <Field label="说明（可选）" htmlFor="record-description">
              <Textarea
                id="record-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="这条记录覆盖什么操作？"
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
          <Button type="submit" form="record-form">
            <Save />
            保存记录
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const EMPTY_STEPS: Array<[string, string, string]> = [
  ["01", "建立记录", "选择目标系统，命名这次操作。"],
  ["02", "录制操作", "在目标页完成一次真实业务操作。"],
  ["03", "生成节点", "转换出可回放的 DSL 节点。"],
];

export function RecordsPage() {
  const navigate = useNavigate();
  const [records, setRecords] = useState<OperationRecord[]>(() => listRecords());
  const [systems] = useState<TargetSystem[]>(() => listSystems());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<OperationRecord | null>(null);
  const [deleting, setDeleting] = useState<OperationRecord | null>(null);

  const systemNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const system of systems) names.set(system.id, system.name);
    return names;
  }, [systems]);

  const openCreate = (): void => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (record: OperationRecord): void => {
    setEditing(record);
    setDialogOpen(true);
  };

  const handleSave = (draft: RecordDraft): void => {
    const now = new Date().toISOString();
    const wasEditing = Boolean(editing);
    const next: OperationRecord = editing
      ? { ...editing, ...draft, updatedAt: now }
      : {
          ...draft,
          id: newId("rec"),
          steps: 0,
          nodes: 0,
          status: "draft",
          createdAt: now,
          updatedAt: now,
        };
    saveRecord(next);
    setRecords(listRecords());
    setEditing(null);
    setDialogOpen(false);
    if (!wasEditing) navigate(`/records/${next.id}/record`);
  };

  const confirmDelete = (): void => {
    if (!deleting) return;
    deleteRecord(deleting.id);
    setRecords(listRecords());
    setDeleting(null);
  };

  return (
    <div className="flex flex-col gap-4 pb-10">
      <PageHeader
        icon={<MonitorDot className="size-6 text-accent shrink-0" />}
        title="操作记录"
        description="一次录制 = 一条记录：打开目标系统，在目标页完成表单填写、下拉选择等操作，停止后自动生成节点并保存。"
        actions={
          <Button size="sm" onClick={openCreate}>
            <Plus />
            新增记录
          </Button>
        }
      />

      {records.length === 0 ? (
        <EmptyState
          icon={<MonitorDot className="size-5" />}
          code="REC"
          title="还没有操作记录"
          description="先建立一条记录，随后在录制工作台里打开目标系统，捕获点击、输入、下拉与页面跳转。"
          action={
            <Button size="sm" onClick={openCreate}>
              <Plus />
              新增第一条记录
            </Button>
          }
        >
          <div className="mx-auto grid w-full max-w-[720px] gap-2 text-left sm:grid-cols-3">
            {EMPTY_STEPS.map(([code, title, text]) => (
              <div key={code} className="rounded-xl border border-line bg-white/70 px-3.5 py-3">
                <div className="font-mono text-[9.5px] tracking-[0.14em] text-accent">{code}</div>
                <div className="mt-1 text-[12.5px] font-semibold">{title}</div>
                <div className="mt-0.5 text-[11.5px] leading-4 text-muted">{text}</div>
              </div>
            ))}
          </div>
        </EmptyState>
      ) : (
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {records.map((record) => (
            <ItemCard
              key={record.id}
              code={`REC-${record.id.slice(-4).toUpperCase()}`}
              icon={<MonitorDot className="size-4 shrink-0 text-accent" />}
              title={record.name}
              badge={
                <Badge variant={record.status === "ready" ? "moss" : "amber"}>
                  {record.status === "ready" ? "已录制" : "待录制"}
                </Badge>
              }
              actions={
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => navigate(`/records/${record.id}/record`)}
                  >
                    <MonitorDot className="size-3.5" />
                    录制
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => openEdit(record)}>
                    <Pencil className="size-3.5" />
                    编辑
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => setDeleting(record)}>
                    <Trash2 className="size-3.5" />
                    删除
                  </Button>
                </>
              }
            >
              {record.description ? <div className="line-clamp-1">{record.description}</div> : null}
              <div className="truncate">
                目标系统：
                {record.systemId ? (systemNames.get(record.systemId) ?? "系统已删除") : "未绑定"}
              </div>
              <div className="font-mono">
                步骤 {record.steps} · 节点 {record.nodes}
              </div>
              <div className="truncate font-mono text-[10.5px]" title={record.targetUrl}>
                {record.targetUrl}
              </div>
              <div>{formatTime(record.updatedAt)}</div>
            </ItemCard>
          ))}
        </section>
      )}

      {dialogOpen ? (
        <RecordDialog
          key={editing?.id ?? "new"}
          record={editing}
          systems={systems}
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
              删除这条记录？
            </AlertDialogTitle>
            <AlertDialogDescription>
              「{deleting?.name}」会从当前浏览器移除，录制内容与回放微调值将无法恢复。
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
