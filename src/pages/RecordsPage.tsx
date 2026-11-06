import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  CheckCircle2,
  FileText,
  Layers,
  ListOrdered,
  Mic,
  Pencil,
  Plus,
  Save,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";

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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { deleteRecord, formatTime, listRecords, listSystems, newId, saveRecord } from "@/lib/store";
import type { OperationRecord, TargetSystem } from "@/lib/types";
import { PageHeader } from "../components/ui";

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
          <DialogTitle>{record ? "编辑记录" : "新增记录"}</DialogTitle>
          <DialogDescription>
            记录是一次操作录制的容器；录制 JSON、转换后的 DSL 与回放微调值都会挂在记录下。
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <form id="record-form" className="grid gap-4" onSubmit={submit}>
            <div className="grid gap-1.5">
              <Label htmlFor="record-name">记录名称</Label>
              <Input
                id="record-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：新建客户"
                autoFocus
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="record-system">所属系统</Label>
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
              <p className="text-[11px] leading-4 text-muted">
                {systems.length === 0 ? (
                  <>
                    还没有系统，先到{" "}
                    <Link className="text-accent underline underline-offset-2" to="/systems">
                      系统管理
                    </Link>{" "}
                    添加，或直接填写目标地址。
                  </>
                ) : (
                  "选择系统后会自动带入目标地址，仍可手动修改。"
                )}
              </p>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="record-url">目标地址</Label>
              <Input
                id="record-url"
                className="font-mono text-[12px]"
                value={targetUrl}
                onChange={(event) => setTargetUrl(event.target.value)}
                placeholder="http://dev.example.com/dashboard"
                spellCheck={false}
              />
              <p className="text-[11px] leading-4 text-muted">
                可使用同源路径（如 <span className="font-mono">/tf/demo/customers.html</span>）
                直接录制；跨域系统需与开发期代理目标一致。
              </p>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="record-description">说明（可选）</Label>
              <Textarea
                id="record-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="这条记录覆盖什么操作？"
              />
            </div>

            {error ? (
              <div className="flex items-start gap-2 rounded-lg border border-danger/20 bg-[#fdf3f0] px-3 py-2 text-[12px] leading-5 text-danger">
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

const STAT_TONES = {
  neutral: "border-line bg-ink/[0.03] text-muted",
  accent: "border-accent/20 bg-accent-soft text-accent",
  moss: "border-moss/20 bg-moss-soft text-moss",
  amber: "border-amber/20 bg-amber-soft text-amber",
} as const;

function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string | number;
  hint: string;
  icon: typeof FileText;
  tone: keyof typeof STAT_TONES;
}) {
  return (
    <Card className="gap-0">
      <CardContent className="px-4 py-3.5">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted">
            {label}
          </span>
          <span
            className={cn(
              "grid size-6 shrink-0 place-items-center rounded-md border",
              STAT_TONES[tone],
            )}
          >
            <Icon className="size-3.5" />
          </span>
        </div>
        <div className="mt-1 text-[22px] font-semibold leading-tight tracking-tight">{value}</div>
        <div className="mt-1 text-[11.5px] leading-4 text-muted">{hint}</div>
      </CardContent>
    </Card>
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

  const totalSteps = records.reduce((total, record) => total + record.steps, 0);
  const totalNodes = records.reduce((total, record) => total + record.nodes, 0);
  const readyCount = records.filter((record) => record.status === "ready").length;

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
    <div className="pb-10">
      <PageHeader
        code="REC / RECORDS"
        title="操作记录"
        description={
          <>
            一次录制 = 一条记录：打开目标系统，在目标页完成表单填写、下拉选择等操作，停止后自动生成节点并保存。
            系统地址请在
            <Link className="ml-1 text-accent underline underline-offset-2" to="/systems">
              系统管理
            </Link>
            维护。
          </>
        }
        actions={
          <Button onClick={openCreate}>
            <Plus />
            新增记录
          </Button>
        }
      />

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="RECORDS"
          value={records.length}
          hint="已建立的记录"
          icon={FileText}
          tone="accent"
        />
        <StatCard
          label="STEPS"
          value={totalSteps}
          hint="录制步骤总数"
          icon={ListOrdered}
          tone="neutral"
        />
        <StatCard
          label="NODES"
          value={totalNodes}
          hint="转换后的节点总数"
          icon={Layers}
          tone="moss"
        />
        <StatCard
          label="READY"
          value={readyCount}
          hint="已保存录制结果的记录"
          icon={CheckCircle2}
          tone="amber"
        />
      </div>

      {records.length === 0 ? (
        <Card className="mt-5 gap-0 border-dashed bg-panel/60 shadow-none">
          <CardContent className="flex flex-col items-center px-6 py-12 text-center">
            <div className="grid size-11 place-items-center rounded-[12px] border border-line bg-white font-mono text-[11px] font-semibold tracking-[0.14em] text-accent">
              REC
            </div>
            <h2 className="mt-4 text-[15px] font-semibold tracking-tight">还没有操作记录</h2>
            <p className="mt-1.5 max-w-[520px] text-[12.5px] leading-5 text-muted">
              先建立一条记录，随后在录制工作台里打开目标系统，捕获点击、输入、下拉与页面跳转。
            </p>
            <Button className="mt-5" onClick={openCreate}>
              <Plus />
              新增第一条记录
            </Button>
            <div className="mt-6 grid w-full max-w-[720px] gap-2 text-left sm:grid-cols-3">
              {EMPTY_STEPS.map(([code, title, text]) => (
                <div key={code} className="rounded-xl border border-line bg-white/70 px-3.5 py-3">
                  <div className="font-mono text-[9.5px] tracking-[0.14em] text-accent">{code}</div>
                  <div className="mt-1 text-[12.5px] font-semibold">{title}</div>
                  <div className="mt-0.5 text-[11.5px] leading-4 text-muted">{text}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="mt-5 gap-0 overflow-hidden">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 border-b border-line px-4 py-3">
            <div className="flex items-center gap-2">
              <CardTitle>记录清单</CardTitle>
              <Badge variant="secondary">{records.length}</Badge>
            </div>
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
              localStorage · 本机保存
            </span>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>记录</TableHead>
                  <TableHead>目标系统</TableHead>
                  <TableHead>步骤</TableHead>
                  <TableHead>节点</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>更新时间</TableHead>
                  <TableHead className="w-[1%] whitespace-nowrap text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((record) => (
                  <TableRow key={record.id}>
                    <TableCell>
                      <div className="font-semibold">{record.name}</div>
                      {record.description ? (
                        <div className="mt-0.5 line-clamp-1 text-[11.5px] text-muted">
                          {record.description}
                        </div>
                      ) : null}
                      <div className="mt-0.5 max-w-[320px] truncate font-mono text-[10.5px] text-muted/80">
                        {record.targetUrl}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-[12px]">
                      {record.systemId ? (
                        (systemNames.get(record.systemId) ?? "系统已删除")
                      ) : (
                        <span className="text-muted">未绑定</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-[12px]">{record.steps}</TableCell>
                    <TableCell className="font-mono text-[12px]">{record.nodes}</TableCell>
                    <TableCell>
                      <Badge variant={record.status === "ready" ? "moss" : "amber"}>
                        {record.status === "ready" ? "已录制" : "待录制"}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-[12px] text-muted">
                      {formatTime(record.updatedAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => navigate(`/records/${record.id}/record`)}
                        >
                          <Mic className="size-3.5" />
                          录制
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => openEdit(record)}>
                          <Pencil className="size-3.5" />
                          编辑
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => setDeleting(record)}
                        >
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
            <AlertDialogTitle>删除这条记录？</AlertDialogTitle>
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
