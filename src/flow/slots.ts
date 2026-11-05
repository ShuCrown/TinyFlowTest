import type { FlowDsl, PickerFilterStep, ValueLike } from "../dsl/index.ts";
import type { FlowSlot } from "../lib/types.ts";

export interface RecordSlot {
  /** 稳定 id：dslNodeId:slot:index */
  id: string;
  dslNodeId: string;
  slot: FlowSlot;
  index?: number;
  label: string;
  kindLabel: string;
  recordedValue: string;
}

const EDITABLE_INTERACT = new Set(["input", "select", "nativeSelect", "check"]);

const INTERACT_LABEL: Record<string, string> = {
  input: "输入值",
  select: "下拉值",
  nativeSelect: "下拉值",
  check: "勾选值",
};

function literalText(value: ValueLike | undefined): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(readValueText).filter(Boolean).join(",");
  return readValueText(value);
}

function readValueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object" && "kind" in value) {
    const expr = value as { kind?: unknown; value?: unknown };
    if (expr.kind === "literal") {
      return expr.value === null || expr.value === undefined ? "" : String(expr.value);
    }
  }
  return "";
}

function filterLabel(step: PickerFilterStep): string {
  return step.target.label ?? step.adapter;
}

/** 操作记录里所有允许流程注入值的槽位。 */
export function listRecordSlots(dsl: FlowDsl): RecordSlot[] {
  const slots: RecordSlot[] = [];
  for (const node of dsl.nodes) {
    if (node.type === "interact") {
      if (!EDITABLE_INTERACT.has(node.adapter)) continue;
      slots.push({
        id: `${node.id}:input`,
        dslNodeId: node.id,
        slot: "input",
        label: node.target.label ?? node.name ?? node.id,
        kindLabel: INTERACT_LABEL[node.adapter] ?? node.adapter,
        recordedValue:
          node.adapter === "check"
            ? String(node.checked ?? literalText(node.value) === "true")
            : literalText(node.value),
      });
      continue;
    }
    if (node.type !== "picker") continue;
    for (const [index, step] of (node.filter?.steps ?? []).entries()) {
      if (step.adapter !== "input" && step.adapter !== "nativeSelect") continue;
      slots.push({
        id: `${node.id}:filter:${index}`,
        dslNodeId: node.id,
        slot: "filter",
        index,
        label: `${node.trigger.label ?? node.name ?? node.id} · ${filterLabel(step)}`,
        kindLabel: "筛选值",
        recordedValue: literalText(step.value),
      });
    }
  }
  return slots;
}
