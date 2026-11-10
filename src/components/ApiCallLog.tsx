import { useState } from "react";
import { FileJson } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** 接口日志条目：录制请求和回放捕获共用。 */
export interface ApiCallEntry {
  method: string;
  url: string;
  /** 0 / 空表示请求已发出但还没拿到响应。 */
  status?: number;
  contentType?: string;
  /** 请求参数，对象或 JSON 文本。 */
  params?: unknown;
  /** 响应体原文，JSON 接口为原始文本。 */
  response?: string;
}

/** 请求参数 / 响应体统一转成可读 JSON；非 JSON 文本原样展示。 */
export function prettyJson(value: unknown): string {
  if (value === undefined || value === null || value === "") return "（无）";
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return "（无）";
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function ApiRequestDialog({
  value,
  onOpenChange,
}: {
  value: ApiCallEntry | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={Boolean(value)} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(720px,calc(100vw-32px))]">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2">
            <Badge variant="secondary" className="shrink-0 font-mono">
              {value?.method}
            </Badge>
            <span className="truncate font-mono text-[12.5px]">{value?.url}</span>
          </DialogTitle>
          <DialogDescription>
            {value?.status !== undefined ? `响应状态 ${value.status}` : "尚未收到响应"}
            {value?.contentType ? ` · ${value.contentType}` : ""}
            {" · 抓取自录制或回放时的接口调用"}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <section>
            <p className="mb-1.5 text-[11px] font-medium text-muted">请求参数</p>
            <pre className="max-h-[200px] overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-white p-3 font-mono text-[10.5px] leading-5 text-ink">
              {prettyJson(value?.params)}
            </pre>
          </section>
          <section>
            <p className="mb-1.5 text-[11px] font-medium text-muted">响应数据</p>
            <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-white p-3 font-mono text-[10.5px] leading-5 text-ink">
              {value?.response !== undefined
                ? prettyJson(value.response)
                : value?.status !== undefined
                  ? "（未捕获到响应体，可能是非文本接口）"
                  : "（等待响应）"}
            </pre>
          </section>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/** 接口调用列表；不传 onSelect 时点击外部弹窗查看 JSON。 */
export function ApiCallRows({
  entries,
  onSelect,
}: {
  entries: ApiCallEntry[];
  onSelect?: (entry: ApiCallEntry) => void;
}) {
  const [selected, setSelected] = useState<ApiCallEntry | null>(null);
  const handleSelect = onSelect ?? setSelected;
  return (
    <>
      <div className="max-h-[180px] divide-y divide-line overflow-y-auto rounded-lg border border-line bg-white">
        {entries.map((entry, index) => (
          <button
            key={`${entry.method}-${entry.url}-${index}`}
            type="button"
            title="查看提交参数与返回结构"
            onClick={() => handleSelect(entry)}
            className="group flex w-full min-w-0 items-center gap-1.5 px-2.5 py-1 text-left transition-colors hover:bg-ink/[0.035]"
          >
            <Badge variant="secondary" className="shrink-0 px-1.5 py-0 font-mono text-[9px]">
              {entry.method}
            </Badge>
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted">
              {entry.url}
            </span>
            {entry.status ? (
              <Badge
                variant={entry.status >= 200 && entry.status < 300 ? "moss" : "destructive"}
                className="shrink-0 px-1.5 py-0 text-[9px]"
              >
                {entry.status}
              </Badge>
            ) : (
              <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[9px]">
                待响应
              </Badge>
            )}
            <FileJson className="size-3 shrink-0 text-muted group-hover:text-accent" />
          </button>
        ))}
      </div>
      {onSelect ? null : (
        <ApiRequestDialog
          value={selected}
          onOpenChange={(open) => {
            if (!open) setSelected(null);
          }}
        />
      )}
    </>
  );
}
