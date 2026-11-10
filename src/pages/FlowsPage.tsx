import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Pencil, Plus, Save, Trash2, TriangleAlert, Workflow, X } from "lucide-react";

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
import { Card } from "@/components/ui/card";
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
import { deleteFlow, formatTime, listFlows, newId, saveFlow } from "../lib/store";
import type { FlowItem } from "../lib/types";

type FlowDraft = Pick<FlowItem, "name" | "description">;

function flowCode(id: string): string {
  return `FLW-${id.slice(-4).toUpperCase()}`;
}

function FlowDialog({
  flow,
  onClose,
  onSave,
}: {
  flow: FlowItem | null;
  onClose: () => void;
  onSave: (draft: FlowDraft) => void;
}) {
  const [name, setName] = useState(flow?.name ?? "");
  const [description, setDescription] = useState(flow?.description ?? "");
  const [error, setError] = useState("");

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!name.trim()) {
      setError("请填写流程名称。");
      return;
    }
    setError("");
    onSave({
      name: name.trim(),
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
          <DialogTitle>{flow ? "编辑流程" : "新建流程"}</DialogTitle>
          <DialogDescription>
            流程用来组织多条操作记录的执行顺序。保存后进入画布，用取值节点把上一步的主键 code
            带到下一步。
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <form id="flow-form" className="grid gap-4" onSubmit={submit}>
            <Field label="流程名称" htmlFor="flow-name">
              <Input
                id="flow-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：客户开户 → 下单"
                autoFocus
              />
            </Field>
            <Field label="说明（可选）" htmlFor="flow-description">
              <Textarea
                id="flow-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="这条流程覆盖的业务链路、前置条件或注意事项"
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
          <Button type="submit" form="flow-form">
            <Save />
            保存流程
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FlowsPage() {
  const navigate = useNavigate();
  const [flows, setFlows] = useState<FlowItem[]>(() => listFlows());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<FlowItem | null>(null);
  const [deleting, setDeleting] = useState<FlowItem | null>(null);

  const openCreate = (): void => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (flow: FlowItem): void => {
    setEditing(flow);
    setDialogOpen(true);
  };

  const handleSave = (draft: FlowDraft): void => {
    const now = new Date().toISOString();
    const wasEditing = Boolean(editing);
    const next: FlowItem = editing
      ? { ...editing, ...draft, updatedAt: now }
      : {
          ...draft,
          id: newId("flw"),
          recordCount: 0,
          status: "draft",
          graph: { nodes: [], edges: [], injections: [], vars: [] },
          createdAt: now,
          updatedAt: now,
        };
    saveFlow(next);
    setFlows(listFlows());
    setEditing(null);
    setDialogOpen(false);
    if (!wasEditing) navigate(`/flows/${next.id}/canvas`);
  };

  const confirmDelete = (): void => {
    if (!deleting) return;
    deleteFlow(deleting.id);
    setFlows(listFlows());
    setDeleting(null);
  };

  return (
    <div className="flex flex-col gap-4 pb-10">
      <PageHeader
        title="流程"
        description="流程把多条操作记录串成顺序执行链；画布里的取值节点负责把前一步保存的主键 code 变成环境变量，再注入下一步的筛选与选择。"
        actions={
          <Button size="sm" variant="default" onClick={openCreate}>
            <Plus />
            新建流程
          </Button>
        }
      />

      {flows.length === 0 ? (
        <EmptyState
          code="FLW"
          title="还没有流程"
          description="先建立流程，再把新建 / 编辑类的操作记录按顺序放进来。编号扣子会把上一步产出的业务编号，带到下一步的字段赋值或筛选。"
          action={
            <Button size="sm" variant="default" onClick={openCreate}>
              <Plus />
              新建第一条流程
            </Button>
          }
        >
          <div className="mx-auto flex max-w-[860px] flex-wrap items-center justify-center gap-2">
            <Card className="min-w-[132px] gap-1 border-l-[3px] border-l-accent p-2.5">
              <span className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-muted">
                OP · 操作记录
              </span>
              <strong className="text-[12.5px] font-semibold">新建客户</strong>
            </Card>
            <span className="font-mono text-[10px] text-muted">──▶</span>
            <Card className="min-w-[132px] gap-1 border-l-[3px] border-l-moss p-2.5">
              <span className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-muted">
                CODE · 编号扣子
              </span>
              <strong className="text-[12.5px] font-semibold">customerCode</strong>
            </Card>
            <span className="font-mono text-[10px] text-muted">──▶</span>
            <Card className="min-w-[132px] gap-1 border-l-[3px] border-l-accent p-2.5">
              <span className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-muted">
                OP · 操作记录
              </span>
              <strong className="text-[12.5px] font-semibold">新建订单</strong>
            </Card>
          </div>
          <p className="mt-3 font-mono text-[10px] tracking-[0.08em] text-muted">
            customerCode 通过虚线扣子注入下一步表单 / 筛选
          </p>
        </EmptyState>
      ) : (
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {flows.map((flow) => (
            <ItemCard
              key={flow.id}
              code={flowCode(flow.id)}
              title={flow.name}
              badge={
                <Badge variant={flow.status === "ready" ? "moss" : "amber"}>
                  {flow.status === "ready" ? "可运行" : "草稿"}
                </Badge>
              }
              actions={
                <>
                  <Button
                    size="sm"
                    variant="default"
                    onClick={() => navigate(`/flows/${flow.id}/canvas`)}
                  >
                    <Workflow className="size-3.5" />
                    画布编排
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => openEdit(flow)}>
                    <Pencil className="size-3.5" />
                    编辑
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => setDeleting(flow)}>
                    <Trash2 className="size-3.5" />
                    删除
                  </Button>
                </>
              }
            >
              <p className="line-clamp-2">{flow.description || "暂无说明。"}</p>
              <div className="font-mono">{flow.recordCount} 条操作记录</div>
              <div>{formatTime(flow.updatedAt)}</div>
            </ItemCard>
          ))}
        </section>
      )}

      {dialogOpen ? (
        <FlowDialog
          key={editing?.id ?? "new"}
          flow={editing}
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
            <AlertDialogTitle>删除这条流程？</AlertDialogTitle>
            <AlertDialogDescription>
              「{deleting?.name}」会从当前浏览器移除，画布编排与注入配置将无法恢复；操作记录本身不会被删除。
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
