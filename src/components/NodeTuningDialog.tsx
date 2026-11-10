import { useEffect, useState } from "react";
import {
  Check,
  FileText,
  ListOrdered,
  RotateCcw,
  SlidersHorizontal,
  TriangleAlert,
  X,
} from "lucide-react";

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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  ExtractNode,
  FlowDsl,
  InteractNode,
  PickerFilterStep,
  PickerNode,
  ValueLike,
} from "@/dsl/index.ts";
import {
  ExtractTuningFields,
  extractEditorOf,
  extractTuningDiff,
  recordedExtractEditor,
  type ExtractEditor,
} from "@/components/ExtractTuningFields";

export type TuningValues = Record<string, unknown>;

interface NodeTuningDialogProps {
  open: boolean;
  dsl: FlowDsl;
  values: TuningValues;
  onOpenChange: (open: boolean) => void;
  onApply: (next: { dsl: FlowDsl; values: TuningValues }) => void;
}

type InteractEditor =
  | { kind: "text"; value: string }
  | { kind: "check"; value: boolean };

interface PickerEditor {
  mode: "text" | "index";
  filters: string[];
  picks: string[];
  indexes: string[];
  /** 切回文本模式时恢复的定位方式：录制时按行选择则保持按行。 */
  textStrategy: "byText" | "byRow";
}


const EDITABLE_ADAPTER = new Set(["input", "select", "nativeSelect", "check"]);

const INTERACT_LABEL: Record<string, string> = {
  input: "输入",
  select: "下拉",
  nativeSelect: "下拉",
  check: "勾选",
};

function literalText(value: ValueLike | undefined): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(readText).filter(Boolean).join(",");
  return readText(value);
}

function readText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object" && "kind" in value) {
    const expr = value as { kind?: unknown; value?: unknown };
    if (expr.kind === "literal") return expr.value === null || expr.value === undefined ? "" : String(expr.value);
  }
  return "";
}

function recordedText(node: InteractNode): string {
  return literalText(node.value);
}

function recordedChecked(node: InteractNode): boolean {
  return node.checked ?? recordedText(node).toLowerCase() === "true";
}

function readPickerOverride(value: unknown): { picks?: string[]; filters?: string[] } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { picks?: unknown; filters?: unknown };
  return {
    picks: Array.isArray(record.picks) ? record.picks.map(String) : undefined,
    filters: Array.isArray(record.filters) ? record.filters.map(String) : undefined,
  };
}

function recordedFilters(node: PickerNode): string[] {
  return (node.filter?.steps ?? []).map((step) => literalText(step.value));
}

function recordedPicks(node: PickerNode): string[] {
  const fromValues = (node.pick.values ?? []).map((item) => item.value ?? "");
  if (fromValues.length > 0) return fromValues;
  const raw = node.pick.byText?.value ?? node.pick.byRow?.keyValue;
  if (Array.isArray(raw)) return raw.map(readText).filter(Boolean);
  const single = readText(raw);
  return single ? [single] : [];
}

function recordedIndexes(node: PickerNode, picks: string[]): number[] {
  const fromNode = node.pick.byIndex?.indexes ?? node.pick.values?.map((item) => item.index ?? 1) ?? [];
  if (fromNode.length >= picks.length) return fromNode;
  return [...fromNode, ...Array.from({ length: picks.length - fromNode.length }, () => 1)];
}

function textStrategyOf(node: PickerNode): "byText" | "byRow" {
  if (node.pick.strategy === "byRow") return "byRow";
  if (node.pick.strategy === "byText") return "byText";
  return node.pick.byIndex?.on === "row" ? "byRow" : "byText";
}

function canUseIndex(node: PickerNode): boolean {
  const picks = node.pick.values ?? [];
  return picks.length > 0 && picks.every((item) => typeof item.index === "number");
}

function nodeLabel(node: PickerNode): string {
  return node.trigger.label ?? node.name ?? node.id;
}

function buildEditors(dsl: FlowDsl, values: TuningValues): {
  interact: Record<string, InteractEditor>;
  picker: Record<string, PickerEditor>;
  extract: Record<string, ExtractEditor>;
} {
  const interact: Record<string, InteractEditor> = {};
  const picker: Record<string, PickerEditor> = {};
  const extract: Record<string, ExtractEditor> = {};
  for (const node of dsl.nodes) {
    if (node.type === "extract") {
      extract[node.id] = extractEditorOf(node, values[node.id]);
      continue;
    }
    if (node.type === "interact") {
      if (!EDITABLE_ADAPTER.has(node.adapter)) continue;
      const override = values[node.id];
      if (node.adapter === "check") {
        interact[node.id] = {
          kind: "check",
          value: typeof override === "boolean" ? override : recordedChecked(node),
        };
      } else {
        interact[node.id] = {
          kind: "text",
          value:
            typeof override === "boolean"
              ? String(override)
              : override === undefined
                ? recordedText(node)
                : String(override),
        };
      }
      continue;
    }
    if (node.type !== "picker") continue;

    const override = readPickerOverride(values[node.id]);
    const picks = recordedPicks(node);
    const filters = recordedFilters(node);
    const indexes = recordedIndexes(node, picks);
    picker[node.id] = {
      mode: node.pick.strategy === "byIndex" ? "index" : "text",
      filters: filters.map((value, index) => override?.filters?.[index] ?? value),
      picks: picks.map((value, index) => override?.picks?.[index] ?? value),
      indexes: indexes.map(String),
      textStrategy: textStrategyOf(node),
    };
  }
  return { interact, picker, extract };
}

function NodeTuningDialog({
  open,
  dsl,
  values,
  onOpenChange,
  onApply,
}: NodeTuningDialogProps) {
  const [interactEditors, setInteractEditors] = useState<Record<string, InteractEditor>>({});
  const [pickerEditors, setPickerEditors] = useState<Record<string, PickerEditor>>({});
  const [extractEditors, setExtractEditors] = useState<Record<string, ExtractEditor>>({});
  const [error, setError] = useState("");
  const hasTunable = dsl.nodes.some(
    (node) =>
      (node.type === "interact" && EDITABLE_ADAPTER.has(node.adapter)) ||
      node.type === "picker" ||
      node.type === "extract",
  );

  useEffect(() => {
    if (!open) return;
    const next = buildEditors(dsl, values);
    setInteractEditors(next.interact);
    setPickerEditors(next.picker);
    setExtractEditors(next.extract);
    setError("");
  }, [open, dsl, values]);

  const patchPicker = (nodeId: string, updater: (editor: PickerEditor) => PickerEditor): void => {
    setPickerEditors((prev) => {
      const current = prev[nodeId];
      if (!current) return prev;
      return { ...prev, [nodeId]: updater(current) };
    });
  };

  const patchExtract = (nodeId: string, next: ExtractEditor): void => {
    setExtractEditors((prev) => ({ ...prev, [nodeId]: next }));
  };

  const resetAll = (): void => {
    const next = buildEditors(dsl, {});
    setInteractEditors(next.interact);
    setPickerEditors(next.picker);
    setExtractEditors(next.extract);
    setError("");
  };

  const apply = (): void => {
    const nextValues: TuningValues = {};
    let problem = "";

    const nodes = dsl.nodes.map((node) => {
      if (node.type === "interact") {
        const editor = interactEditors[node.id];
        if (!editor) return node;
        if (editor.kind === "check") {
          if (editor.value !== recordedChecked(node)) nextValues[node.id] = editor.value;
        } else if (editor.value !== recordedText(node)) {
          nextValues[node.id] = editor.value;
        }
        return node;
      }
      if (node.type === "extract") {
        const editor = extractEditors[node.id];
        if (!editor) return node;
        const diff = extractTuningDiff(editor, recordedExtractEditor(node));
        if (diff.error) {
          problem = diff.error;
          return node;
        }
        if (diff.tuning) nextValues[node.id] = diff.tuning;
        return node;
      }
      if (node.type !== "picker") return node;

      const editor = pickerEditors[node.id];
      if (!editor) return node;
      const defaults = recordedPicks(node);
      const filterDefaults = recordedFilters(node);
      const override: { picks?: string[]; filters?: string[] } = {};
      if (editor.filters.some((value, index) => value !== (filterDefaults[index] ?? ""))) {
        override.filters = editor.filters;
      }
      if (editor.mode === "text" && editor.picks.some((value, index) => value !== (defaults[index] ?? ""))) {
        override.picks = editor.picks;
      }
      if (override.picks || override.filters) nextValues[node.id] = override;

      if (editor.mode === "index") {
        const indexes: number[] = [];
        for (const [index, raw] of editor.indexes.entries()) {
          const parsed = Number.parseInt(raw, 10);
          if (!Number.isInteger(parsed) || parsed < 1) {
            problem = `第 ${index + 1} 个选项的位置必须是大于 0 的整数。`;
            return node;
          }
          indexes.push(parsed);
        }
        return {
          ...node,
          pick: {
            ...node.pick,
            strategy: "byIndex" as const,
            byIndex: {
              indexes,
              on: editor.textStrategy === "byRow" ? ("row" as const) : ("item" as const),
            },
          },
        };
      }
      return {
        ...node,
        pick: { ...node.pick, strategy: editor.textStrategy },
      };
    });

    if (problem) {
      setError(problem);
      return;
    }
    onApply({ dsl: { ...dsl, nodes }, values: nextValues });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(860px,calc(100vw-32px))] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SlidersHorizontal className="size-4 text-accent" />
            微调回放值
          </DialogTitle>
          <DialogDescription>
            只改回放时使用的值，不改录制步骤；修改会随记录一起保存，重新录制时清空。
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="min-h-0 flex-1 overflow-y-auto p-0">
          {error ? (
            <div className="mx-5 mt-4 flex items-start gap-2 rounded-lg border border-danger/20 bg-danger-soft px-3 py-2 text-[12px] leading-5 text-danger">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}

          {!hasTunable ? (
            <p className="px-5 py-8 text-center text-[12px] text-muted">
              当前流程没有可微调的输入值或取值配置，可直接回放。
            </p>
          ) : (
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-panel">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-12">#</TableHead>
                  <TableHead className="w-[210px]">节点</TableHead>
                  <TableHead className="w-[180px]">可调项</TableHead>
                  <TableHead>回放值</TableHead>
                  <TableHead className="w-14" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {dsl.nodes.map((node, nodeIndex) => {
                  if (node.type === "interact") {
                    const editor = interactEditors[node.id];
                    if (!editor) return null;
                    return (
                      <TableRow key={node.id}>
                        <TableCell className="font-mono text-[10px] text-muted">
                          {String(nodeIndex + 1).padStart(2, "0")}
                        </TableCell>
                        <TableCell>
                          <div className="text-[12px] font-medium">
                            {node.target.label ?? node.name ?? node.id}
                          </div>
                          <Badge variant="outline" className="mt-1">
                            {INTERACT_LABEL[node.adapter] ?? node.adapter}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-[11.5px] text-muted">
                          {editor.kind === "check" ? "勾选状态" : "输入值"}
                        </TableCell>
                        <TableCell>
                          {editor.kind === "check" ? (
                            <label className="flex items-center gap-2 text-[11.5px] text-muted">
                              <input
                                type="checkbox"
                                className="size-4 accent-accent"
                                checked={editor.value}
                                onChange={(event) => {
                                  const checked = event.target.checked;
                                  setInteractEditors((prev) => ({
                                    ...prev,
                                    [node.id]: { kind: "check", value: checked },
                                  }));
                                }}
                              />
                              {editor.value ? "回放时勾选" : "回放时取消"}
                            </label>
                          ) : (
                            <Input
                              className="h-8 text-[12px]"
                              value={editor.value}
                              placeholder="回放时使用的值"
                              onChange={(event) => {
                                const value = event.target.value;
                                setInteractEditors((prev) => ({
                                  ...prev,
                                  [node.id]: { kind: "text", value },
                                }));
                              }}
                            />
                          )}
                        </TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            variant="ghost"
                            title="恢复录制值"
                            aria-label="恢复录制值"
                            onClick={() => {
                              setInteractEditors((prev) => ({
                                ...prev,
                                [node.id]:
                                  editor.kind === "check"
                                    ? { kind: "check", value: recordedChecked(node) }
                                    : { kind: "text", value: recordedText(node) },
                              }));
                            }}
                          >
                            <RotateCcw className="size-3.5" />
                            恢复
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  }

                  if (node.type === "extract") {
                    const editor = extractEditors[node.id];
                    if (!editor) return null;
                    return (
                      <TableRow key={node.id}>
                        <TableCell className="align-top font-mono text-[10px] text-muted">
                          {String(nodeIndex + 1).padStart(2, "0")}
                        </TableCell>
                        <TableCell className="align-top">
                          <div className="text-[12px] font-medium">
                            {node.source === "response" ||
                            node.source === "js" ||
                            node.source === "const"
                              ? (node.name ?? node.varName ?? node.id)
                              : (node.target.label ?? node.name ?? node.varName ?? node.id)}
                          </div>
                          <div className="mt-1 flex flex-wrap gap-1">
                            <Badge variant="outline">取值</Badge>
                            <Badge variant="secondary">
                              {editor.source === "response"
                                ? "接口"
                                : editor.source === "js"
                                  ? "JS"
                                  : editor.source === "const"
                                    ? "手动"
                                    : editor.locate === "cell"
                                      ? "表格"
                                      : "DOM"}
                            </Badge>
                          </div>
                          <div className="mt-1 truncate font-mono text-[10px] text-muted">
                            变量 {node.varName || "未命名"}
                          </div>
                        </TableCell>
                        <TableCell className="align-top text-[11.5px] text-muted">
                          取值配置
                          <div className="text-[10px] leading-4 text-muted/80">
                            变量名在流程画布 ENV 面板改
                          </div>
                        </TableCell>
                        <TableCell className="py-2 align-top">
                          <ExtractTuningFields
                            editor={editor}
                            onChange={(next) => patchExtract(node.id, next)}
                          />
                        </TableCell>
                        <TableCell className="align-top">
                          <Button
                            size="sm"
                            variant="ghost"
                            title="恢复录制值"
                            aria-label="恢复取值配置"
                            onClick={() => patchExtract(node.id, recordedExtractEditor(node))}
                          >
                            <RotateCcw className="size-3.5" />
                            恢复
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  }

                  if (node.type !== "picker") return null;
                  const editor = pickerEditors[node.id];
                  if (!editor) return null;

                  const filters = (node.filter?.steps ?? [])
                    .map((step, filterIndex) => ({ step, filterIndex }))
                    .filter(({ step }) => step.adapter === "input" || step.adapter === "nativeSelect");
                  const pickCount =
                    editor.mode === "index" ? editor.indexes.length : editor.picks.length;
                  const groupRows = 1 + filters.length + pickCount;
                  const indexMode = editor.mode === "index";
                  const usableIndex = canUseIndex(node);
                  const defaults = recordedPicks(node);
                  const defaultIndexes = recordedIndexes(node, defaults);

                  return (
                    <PickerRows
                      key={node.id}
                      node={node}
                      nodeIndex={nodeIndex}
                      editor={editor}
                      filters={filters}
                      pickCount={pickCount}
                      groupRows={groupRows}
                      indexMode={indexMode}
                      usableIndex={usableIndex}
                      defaults={defaults}
                      defaultIndexes={defaultIndexes}
                      patchPicker={patchPicker}
                    />
                  );
                })}
              </TableBody>
            </Table>
          )}
        </DialogBody>

        <DialogFooter className="shrink-0 sm:justify-between">
          <Button size="sm" variant="ghost" onClick={resetAll}>
            <RotateCcw />
            恢复录制值
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              <X />
              取消
            </Button>
            <Button onClick={apply}>
              <Check />
              应用
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface PickerRowsProps {
  node: PickerNode;
  nodeIndex: number;
  editor: PickerEditor;
  filters: Array<{ step: PickerFilterStep; filterIndex: number }>;
  pickCount: number;
  groupRows: number;
  indexMode: boolean;
  usableIndex: boolean;
  defaults: string[];
  defaultIndexes: number[];
  patchPicker: (nodeId: string, updater: (editor: PickerEditor) => PickerEditor) => void;
}

function PickerRows({
  node,
  nodeIndex,
  editor,
  filters,
  pickCount,
  groupRows,
  indexMode,
  usableIndex,
  defaults,
  defaultIndexes,
  patchPicker,
}: PickerRowsProps) {
  return (
    <>
      <TableRow className="border-b-0">
        <TableCell rowSpan={groupRows} className="align-top font-mono text-[10px] text-muted">
          {String(nodeIndex + 1).padStart(2, "0")}
        </TableCell>
        <TableCell rowSpan={groupRows} className="align-top">
          <div className="text-[12px] font-medium">{nodeLabel(node)}</div>
          <div className="mt-1 flex flex-wrap gap-1">
            <Badge variant="outline">选择器</Badge>
            {node.pick.multi ? <Badge variant="secondary">多选</Badge> : null}
          </div>
        </TableCell>
        <TableCell className="text-[11.5px] text-muted">定位方式</TableCell>
        <TableCell>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant={indexMode ? "outline" : "secondary"}
              aria-pressed={!indexMode}
              onClick={() => patchPicker(node.id, (current) => ({ ...current, mode: "text" }))}
            >
              <FileText className="size-3.5" />
              按文本
            </Button>
            <Button
              size="sm"
              variant={indexMode ? "secondary" : "outline"}
              aria-pressed={indexMode}
              disabled={!usableIndex}
              title={usableIndex ? undefined : "该节点没有记录选项位置，无法按位置选择"}
              onClick={() => patchPicker(node.id, (current) => ({ ...current, mode: "index" }))}
            >
              <ListOrdered className="size-3.5" />
              按位置
            </Button>
            {indexMode ? (
              <span className="text-[10.5px] text-muted">按列表第 N 项点击，顺序变化会点错</span>
            ) : null}
          </div>
        </TableCell>
        <TableCell />
      </TableRow>

      {filters.map(({ step, filterIndex }) => {
        const recorded = literalText(step.value);
        const current = editor.filters[filterIndex] ?? "";
        return (
          <TableRow key={`${node.id}:filter:${filterIndex}`}>
            <TableCell className="text-[11.5px] text-muted">
              筛选值
              <div className="text-[10px] text-muted/80">{step.target.label ?? "未命名目标"}</div>
            </TableCell>
            <TableCell>
              <Input
                className="h-8 text-[12px]"
                value={current}
                placeholder="空 = 使用录制值"
                onChange={(event) => {
                  const value = event.target.value;
                  patchPicker(node.id, (existing) => ({
                    ...existing,
                    filters: existing.filters.map((item, index) =>
                      index === filterIndex ? value : item,
                    ),
                  }));
                }}
              />
            </TableCell>
            <TableCell>
              <Button
                size="sm"
                variant="ghost"
                title="恢复录制值"
                aria-label="恢复筛选值"
                onClick={() =>
                  patchPicker(node.id, (existing) => ({
                    ...existing,
                    filters: existing.filters.map((item, index) =>
                      index === filterIndex ? recorded : item,
                    ),
                  }))
                }
              >
                <RotateCcw className="size-3.5" />
                恢复
              </Button>
            </TableCell>
          </TableRow>
        );
      })}

      {Array.from({ length: pickCount }, (_, pickIndex) => {
        if (indexMode) {
          const original = defaultIndexes[pickIndex] ?? 1;
          const current = editor.indexes[pickIndex] ?? "";
          return (
            <TableRow key={`${node.id}:index:${pickIndex}`}>
              <TableCell className="text-[11.5px] text-muted">
                位置 {pickIndex + 1}
                {current === String(original) ? null : (
                  <div className="text-[10px] text-muted/80">原位置：{original}</div>
                )}
              </TableCell>
              <TableCell>
                <span className="flex items-center gap-1.5 text-[11.5px] text-muted">
                  第
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    className="h-8 w-20 text-[12px]"
                    value={editor.indexes[pickIndex] ?? ""}
                    aria-label={`第 ${pickIndex + 1} 项的位置`}
                    onChange={(event) => {
                      const value = event.target.value;
                      patchPicker(node.id, (existing) => ({
                        ...existing,
                        indexes: existing.indexes.map((item, index) =>
                          index === pickIndex ? value : item,
                        ),
                      }));
                    }}
                  />
                  项
                </span>
              </TableCell>
              <TableCell>
                <Button
                  size="sm"
                  variant="ghost"
                  title="恢复录制位置"
                  aria-label="恢复录制位置"
                  onClick={() =>
                    patchPicker(node.id, (existing) => ({
                      ...existing,
                      indexes: existing.indexes.map((item, index) =>
                        index === pickIndex ? String(defaultIndexes[pickIndex] ?? 1) : item,
                      ),
                    }))
                  }
                >
                  <RotateCcw className="size-3.5" />
                  恢复
                </Button>
              </TableCell>
            </TableRow>
          );
        }
        const recorded = defaults[pickIndex] ?? "";
        const current = editor.picks[pickIndex] ?? "";
        return (
          <TableRow key={`${node.id}:pick:${pickIndex}`}>
            <TableCell className="text-[11.5px] text-muted">
              选择 {pickIndex + 1}
              {current === recorded ? null : (
                <div className="text-[10px] text-muted/80">原录制值：{recorded || "空"}</div>
              )}
            </TableCell>
            <TableCell>
              <Input
                className="h-8 text-[12px]"
                value={editor.picks[pickIndex] ?? ""}
                placeholder="空 = 使用录制值"
                onChange={(event) => {
                  const value = event.target.value;
                  patchPicker(node.id, (existing) => ({
                    ...existing,
                    picks: existing.picks.map((item, index) =>
                      index === pickIndex ? value : item,
                    ),
                  }));
                }}
              />
            </TableCell>
            <TableCell>
              <Button
                size="sm"
                variant="ghost"
                title="恢复录制值"
                aria-label="恢复选项值"
                onClick={() =>
                  patchPicker(node.id, (existing) => ({
                    ...existing,
                    picks: existing.picks.map((item, index) =>
                      index === pickIndex ? recorded : item,
                    ),
                  }))
                }
              >
                <RotateCcw className="size-3.5" />
                恢复
              </Button>
            </TableCell>
          </TableRow>
        );
      })}
    </>
  );
}

export { NodeTuningDialog };
