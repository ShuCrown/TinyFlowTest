import { useState, type FormEvent } from "react";
import { Badge, Button, Dialog, EmptyState, Field, PageHeader, StatCard } from "../components/ui";
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
      title={flow ? "编辑流程" : "新建流程"}
      description="流程用来组织多条操作记录的执行顺序。画布编排和编号扣子会在下一步接入。"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" type="submit" form="flow-form">
            保存流程
          </Button>
        </>
      }
    >
      <form id="flow-form" className="grid gap-4" onSubmit={submit}>
        <Field label="流程名称">
          <input
            className="tf-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：客户开户 → 下单"
            autoFocus
          />
        </Field>
        <Field label="说明（可选）">
          <textarea
            className="tf-textarea"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="这条流程覆盖的业务链路、前置条件或注意事项"
          />
        </Field>
        {error ? (
          <p className="rounded-lg border border-danger/20 bg-[#fdf3f0] px-3 py-2 text-[12px] leading-5 text-danger">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}

export function FlowsPage() {
  const [flows, setFlows] = useState<FlowItem[]>(() => listFlows());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<FlowItem | null>(null);

  const draftCount = flows.filter((flow) => flow.status === "draft").length;
  const readyCount = flows.filter((flow) => flow.status === "ready").length;
  const totalRecords = flows.reduce((total, flow) => total + flow.recordCount, 0);

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
    const next: FlowItem = editing
      ? { ...editing, ...draft, updatedAt: now }
      : {
          ...draft,
          id: newId("flw"),
          recordCount: 0,
          status: "draft",
          createdAt: now,
          updatedAt: now,
        };
    saveFlow(next);
    setFlows(listFlows());
    setEditing(null);
    setDialogOpen(false);
  };

  const handleDelete = (flow: FlowItem): void => {
    if (!window.confirm(`删除流程「${flow.name}」？`)) return;
    deleteFlow(flow.id);
    setFlows(listFlows());
  };

  return (
    <div className="pb-10">
      <PageHeader
        code="FLW / FLOWS"
        title="流程"
        description="流程把多条操作记录串成顺序执行链，用一个稳定的流程编号选择执行；编号扣子负责把前一步的产出带到下一步的表单或筛选。"
        actions={
          <Button variant="primary" onClick={openCreate}>
            新建流程
          </Button>
        }
      />

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="FLOWS" value={flows.length} hint="已建立的流程" tone="accent" />
        <StatCard label="DRAFT" value={draftCount} hint="还在编排中的流程" tone="amber" />
        <StatCard label="READY" value={readyCount} hint="可执行流程" tone="moss" />
        <StatCard label="RECORDS" value={totalRecords} hint="流程内操作记录数" />
      </div>

      {flows.length === 0 ? (
        <div className="mt-5">
          <EmptyState
            code="FLW"
            title="还没有流程"
            description="先建立流程，再把新建 / 编辑类的操作记录按顺序放进来。编号扣子会把上一步产出的业务编号，带到下一步的字段赋值或筛选。"
            action={
              <Button variant="primary" onClick={openCreate}>
                新建第一条流程
              </Button>
            }
          >
            <div className="mx-auto flex max-w-[860px] flex-wrap items-center justify-center gap-2">
              <div className="tf-node-chip border-l-[3px] border-l-accent">
                <span>OP · 操作记录</span>
                <strong>新建客户</strong>
              </div>
              <span className="font-mono text-[10px] text-muted">──▶</span>
              <div className="tf-node-chip border-l-[3px] border-l-moss">
                <span>CODE · 编号扣子</span>
                <strong>customerCode</strong>
              </div>
              <span className="font-mono text-[10px] text-muted">──▶</span>
              <div className="tf-node-chip border-l-[3px] border-l-accent">
                <span>OP · 操作记录</span>
                <strong>新建订单</strong>
              </div>
            </div>
            <p className="mt-3 font-mono text-[10px] tracking-[0.08em] text-muted">
              customerCode 通过虚线扣子注入下一步表单 / 筛选
            </p>
          </EmptyState>
        </div>
      ) : (
        <section className="mt-5 grid gap-3 md:grid-cols-2">
          {flows.map((flow) => (
            <article key={flow.id} className="tf-panel flex flex-col p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted">
                    {flowCode(flow.id)}
                  </div>
                  <h2 className="mt-1 truncate text-[15px] font-semibold tracking-tight">
                    {flow.name}
                  </h2>
                </div>
                <Badge tone={flow.status === "ready" ? "moss" : "amber"}>
                  {flow.status === "ready" ? "可运行" : "草稿"}
                </Badge>
              </div>

              <p className="mt-2 line-clamp-2 min-h-[38px] text-[12px] leading-5 text-muted">
                {flow.description || "暂无说明。"}
              </p>

              <div className="mt-4 flex items-center justify-between gap-2 border-t border-line pt-3">
                <span className="font-mono text-[10.5px] text-muted">
                  {flow.recordCount} 条操作记录
                </span>
                <span className="text-[11.5px] text-muted">{formatTime(flow.updatedAt)}</span>
              </div>

              <div className="mt-3 flex gap-2">
                <Button size="sm" onClick={() => openEdit(flow)}>
                  编辑
                </Button>
                <Button size="sm" variant="danger" onClick={() => handleDelete(flow)}>
                  删除
                </Button>
              </div>
            </article>
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
    </div>
  );
}
