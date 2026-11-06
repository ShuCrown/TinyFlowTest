import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { CellRef, ExtractNode } from "@/dsl/index.ts";
import type { ExtractRead, ExtractTuning } from "@/lib/types";
import { readExtractTuning } from "@/flow/extract-tuning";

type DomRowMode = "rowValue" | "rowText" | "rowIndex";

export type ExtractEditor =
  | {
      source: "dom";
      locate: "cell" | "css";
      read: ExtractRead;
      attribute: string;
      rowMode: DomRowMode;
      rowValue: string;
      rowIndex: string;
      pattern: string;
    }
  | {
      source: "response";
      urlContains: string;
      bodyContains: string;
      path: string;
      pattern: string;
    }
  | {
      source: "js";
      js: string;
      pattern: string;
    }
  | {
      source: "const";
      value: string;
    };

function domCellOf(node: ExtractNode): CellRef | undefined {
  if (
    node.source === "response" ||
    node.source === "js" ||
    node.source === "const"
  ) {
    return undefined;
  }
  const strategy = node.target.strategies.find((item) => item.type === "cell");
  return strategy?.type === "cell" ? strategy.cell : undefined;
}

export function recordedExtractEditor(node: ExtractNode): ExtractEditor {
  const pattern = node.pattern ?? "";
  if (node.source === "const") {
    return { source: "const", value: node.value };
  }
  if (node.source === "response") {
    return {
      source: "response",
      urlContains: node.response.urlContains ?? "",
      bodyContains: node.response.bodyContains ?? "",
      path: node.response.path ?? "",
      pattern,
    };
  }
  if (node.source === "js") {
    return { source: "js", js: node.js ?? "", pattern };
  }
  const cell = domCellOf(node);
  const rowMode =
    cell?.rowIndex !== undefined
      ? "rowIndex"
      : cell?.rowText !== undefined
        ? "rowText"
        : "rowValue";
  return {
    source: "dom",
    locate: cell ? "cell" : "css",
    read: node.read,
    attribute: node.attribute ?? "",
    rowMode,
    rowValue:
      rowMode === "rowText"
        ? (cell?.rowText ?? "")
        : rowMode === "rowValue"
          ? (cell?.rowValue ?? "")
          : "",
    rowIndex: String(cell?.rowIndex ?? 1),
    pattern,
  };
}

export function extractEditorOf(node: ExtractNode, override: unknown): ExtractEditor {
  const editor = recordedExtractEditor(node);
  const tuning = readExtractTuning(override);
  if (!tuning) return editor;
  if (editor.source === "const") {
    return {
      source: "const",
      value: tuning.value !== undefined ? tuning.value : editor.value,
    };
  }
  if (editor.source === "dom") {
    return {
      ...editor,
      read: tuning.read ?? editor.read,
      attribute: tuning.attribute !== undefined ? tuning.attribute : editor.attribute,
      pattern: tuning.pattern !== undefined ? tuning.pattern : editor.pattern,
      ...(tuning.cell
        ? tuning.cell.mode === "rowIndex"
          ? { rowMode: "rowIndex", rowIndex: String(tuning.cell.rowIndex) }
          : tuning.cell.mode === "rowText"
            ? { rowMode: "rowText", rowValue: tuning.cell.rowText }
            : { rowMode: "rowValue", rowValue: tuning.cell.rowValue }
        : {}),
    };
  }
  if (editor.source === "response") {
    return {
      ...editor,
      urlContains: tuning.response?.urlContains ?? editor.urlContains,
      bodyContains: tuning.response?.bodyContains ?? editor.bodyContains,
      path: tuning.response?.path ?? editor.path,
      pattern: tuning.pattern !== undefined ? tuning.pattern : editor.pattern,
    };
  }
  return {
    ...editor,
    js: tuning.js !== undefined ? tuning.js : editor.js,
    pattern: tuning.pattern !== undefined ? tuning.pattern : editor.pattern,
  };
}

/** 只记录与录制值不同的字段，避免覆盖项把之后改动的录制配置锁死。 */
export function extractTuningDiff(
  editor: ExtractEditor,
  defaults: ExtractEditor,
): { tuning: ExtractTuning | null; error?: string } {
  if (editor.source !== defaults.source) return { tuning: null };
  const tuning: ExtractTuning = {};
  let changed = false;

  if (editor.source === "dom" && defaults.source === "dom") {
    if (editor.read !== defaults.read) {
      tuning.read = editor.read;
      changed = true;
    }
    if (editor.attribute !== defaults.attribute) {
      tuning.attribute = editor.attribute;
      changed = true;
    }
    if (editor.pattern !== defaults.pattern) {
      tuning.pattern = editor.pattern;
      changed = true;
    }
    if (
      editor.locate === "cell" &&
      (editor.rowMode !== defaults.rowMode ||
        editor.rowValue !== defaults.rowValue ||
        editor.rowIndex !== defaults.rowIndex)
    ) {
      if (editor.rowMode === "rowIndex") {
        const index = Number.parseInt(editor.rowIndex, 10);
        if (!Number.isInteger(index) || index < 1) {
          return { tuning: null, error: "行序号必须是大于 0 的整数。" };
        }
        tuning.cell = { mode: "rowIndex", rowIndex: index };
      } else if (editor.rowMode === "rowText") {
        tuning.cell = { mode: "rowText", rowText: editor.rowValue };
      } else {
        tuning.cell = { mode: "rowValue", rowValue: editor.rowValue };
      }
      changed = true;
    }
  } else if (editor.source === "response" && defaults.source === "response") {
    if (editor.urlContains !== defaults.urlContains) {
      tuning.response = { ...tuning.response, urlContains: editor.urlContains };
      changed = true;
    }
    if (editor.bodyContains !== defaults.bodyContains) {
      tuning.response = { ...tuning.response, bodyContains: editor.bodyContains };
      changed = true;
    }
    if (editor.path !== defaults.path) {
      tuning.response = { ...tuning.response, path: editor.path };
      changed = true;
    }
    if (editor.pattern !== defaults.pattern) {
      tuning.pattern = editor.pattern;
      changed = true;
    }
  } else if (editor.source === "js" && defaults.source === "js") {
    if (editor.js !== defaults.js) {
      tuning.js = editor.js;
      changed = true;
    }
    if (editor.pattern !== defaults.pattern) {
      tuning.pattern = editor.pattern;
      changed = true;
    }
  } else if (editor.source === "const" && defaults.source === "const") {
    if (editor.value !== defaults.value) {
      tuning.value = editor.value;
      changed = true;
    }
  }

  return changed ? { tuning } : { tuning: null };
}

export function ExtractTuningFields({
  editor,
  onChange,
}: {
  editor: ExtractEditor;
  onChange: (next: ExtractEditor) => void;
}) {
  if (editor.source === "dom") {
    return (
      <div className="grid gap-1.5">
        <div className="flex items-center gap-1.5">
          <span className="w-14 shrink-0 text-[10.5px] text-muted">读取</span>
          <Select
            value={editor.read}
            onValueChange={(next) => onChange({ ...editor, read: next as ExtractRead })}
          >
            <SelectTrigger size="xs" className="min-w-0 flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="text">文本</SelectItem>
              <SelectItem value="value">表单值</SelectItem>
              <SelectItem value="attribute">属性</SelectItem>
            </SelectContent>
          </Select>
          {editor.read === "attribute" ? (
            <Input
              className="h-7 min-w-0 flex-1 text-[11px]"
              value={editor.attribute}
              placeholder="属性名"
              spellCheck={false}
              onChange={(event) => onChange({ ...editor, attribute: event.target.value })}
            />
          ) : null}
        </div>

        {editor.locate === "cell" ? (
          <div className="flex items-center gap-1.5">
            <span className="w-14 shrink-0 text-[10.5px] text-muted">行匹配</span>
            <Select
              value={editor.rowMode}
              onValueChange={(next) =>
                onChange({ ...editor, rowMode: next as DomRowMode })
              }
            >
              <SelectTrigger size="xs" className="w-[110px] shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="rowValue">按行值</SelectItem>
                <SelectItem value="rowText">按整行文本</SelectItem>
                <SelectItem value="rowIndex">第 N 行</SelectItem>
              </SelectContent>
            </Select>
            {editor.rowMode === "rowIndex" ? (
              <Input
                type="number"
                min={1}
                step={1}
                className="h-7 w-16 text-[11px]"
                value={editor.rowIndex}
                onChange={(event) => onChange({ ...editor, rowIndex: event.target.value })}
              />
            ) : (
              <Input
                className="h-7 min-w-0 flex-1 text-[11px]"
                value={editor.rowValue}
                placeholder={
                  editor.rowMode === "rowText" ? "整行文本" : "行值，支持 {{变量}}"
                }
                spellCheck={false}
                onChange={(event) => onChange({ ...editor, rowValue: event.target.value })}
              />
            )}
          </div>
        ) : null}

        <div className="flex items-center gap-1.5">
          <span className="w-14 shrink-0 text-[10.5px] text-muted">正则</span>
          <Input
            className="h-7 min-w-0 flex-1 font-mono text-[11px]"
            value={editor.pattern}
            placeholder="清洗正则（可选）"
            spellCheck={false}
            onChange={(event) => onChange({ ...editor, pattern: event.target.value })}
          />
        </div>
      </div>
    );
  }

  if (editor.source === "response") {
    return (
      <div className="grid gap-1.5">
        <div className="flex items-center gap-1.5">
          <span className="w-14 shrink-0 text-[10.5px] text-muted">URL</span>
          <Input
            className="h-7 min-w-0 flex-1 font-mono text-[11px]"
            value={editor.urlContains}
            placeholder="URL 包含"
            spellCheck={false}
            onChange={(event) => onChange({ ...editor, urlContains: event.target.value })}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-14 shrink-0 text-[10.5px] text-muted">请求体</span>
          <Input
            className="h-7 min-w-0 flex-1 font-mono text-[11px]"
            value={editor.bodyContains}
            placeholder="请求体包含（可选）"
            spellCheck={false}
            onChange={(event) => onChange({ ...editor, bodyContains: event.target.value })}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-14 shrink-0 text-[10.5px] text-muted">路径</span>
          <Input
            className="h-7 min-w-0 flex-1 font-mono text-[11px]"
            value={editor.path}
            placeholder="JSON 路径（可选）"
            spellCheck={false}
            onChange={(event) => onChange({ ...editor, path: event.target.value })}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-14 shrink-0 text-[10.5px] text-muted">正则</span>
          <Input
            className="h-7 min-w-0 flex-1 font-mono text-[11px]"
            value={editor.pattern}
            placeholder="清洗正则（可选）"
            spellCheck={false}
            onChange={(event) => onChange({ ...editor, pattern: event.target.value })}
          />
        </div>
      </div>
    );
  }

  if (editor.source === "const") {
    return (
      <div className="flex items-center gap-1.5">
        <span className="w-14 shrink-0 text-[10.5px] text-muted">值</span>
        <Input
          className="h-7 min-w-0 flex-1 text-[11px]"
          value={editor.value}
          placeholder="手动值"
          spellCheck={false}
          onChange={(event) => onChange({ ...editor, value: event.target.value })}
        />
      </div>
    );
  }

  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-1.5">
        <span className="w-14 shrink-0 text-[10.5px] text-muted">表达式</span>
        <Input
          className="h-7 min-w-0 flex-1 font-mono text-[11px]"
          value={editor.js}
          placeholder="页面 JS 表达式"
          spellCheck={false}
          onChange={(event) => onChange({ ...editor, js: event.target.value })}
        />
      </div>
      <div className="flex items-center gap-1.5">
        <span className="w-14 shrink-0 text-[10.5px] text-muted">正则</span>
        <Input
          className="h-7 min-w-0 flex-1 font-mono text-[11px]"
          value={editor.pattern}
          placeholder="清洗正则（可选）"
          spellCheck={false}
          onChange={(event) => onChange({ ...editor, pattern: event.target.value })}
        />
      </div>
    </div>
  );
}
