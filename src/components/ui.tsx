import type { ReactNode } from "react";

import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";

export function PageHeader({
  title,
  icon,
  description,
  actions,
}: {
  title: string;
  icon?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Card className="flex-row flex-wrap items-end justify-between gap-4 px-5 py-4">
      <div className="min-w-0">
        <h1 className="tf-display flex items-center gap-2.5 text-[26px] leading-tight">
          {icon ? <span className="shrink-0 text-accent">{icon}</span> : null}
          <span>{title}</span>
        </h1>
        {description ? (
          <p className="mt-2 max-w-[860px] text-[12.5px] leading-5 text-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </Card>
  );
}

export function ItemCard({
  code,
  title,
  icon,
  badge,
  children,
  actions,
}: {
  code?: string;
  title: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <Card className="h-full gap-0 p-0 transition-shadow hover:shadow-[0_4px_20px_-2px_rgba(44,38,32,0.08)]">
      <div className="flex items-start justify-between gap-2 px-4 pb-2 pt-4">
        <div className="min-w-0">
          {code ? <span className="tf-kicker">{code}</span> : null}
          <h2 className="mt-1 flex items-center gap-1.5 truncate text-[14.5px] font-semibold tracking-tight">
            {icon ? <span className="shrink-0 text-accent">{icon}</span> : null}
            <span className="truncate">{title}</span>
          </h2>
        </div>
        {badge}
      </div>
      <div className="flex-1 space-y-1.5 px-4 text-[11.5px] leading-5 text-muted">{children}</div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-line px-4 py-3">
        {actions}
      </div>
    </Card>
  );
}

export function EmptyState({
  code,
  icon,
  title,
  description,
  action,
  children,
}: {
  code?: string;
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Card className="items-center border-dashed bg-panel/60 px-6 py-12 text-center shadow-none">
      <div className="grid h-11 w-11 place-items-center rounded-[12px] border border-accent/20 bg-accent-soft font-mono text-[11px] font-semibold tracking-[0.14em] text-accent">
        {icon ?? code}
      </div>
      <h2 className="mt-4 text-[15px] font-semibold tracking-tight">{title}</h2>
      {description ? (
        <p className="mt-1.5 max-w-[520px] text-[12.5px] leading-5 text-muted">{description}</p>
      ) : null}
      {children ? <div className="mt-6 w-full">{children}</div> : null}
      {action ? <div className="mt-6">{action}</div> : null}
    </Card>
  );
}

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor} className="text-[12px] font-medium text-ink">
        {label}
      </Label>
      {children}
      {hint ? <p className="text-[11px] leading-4 text-muted">{hint}</p> : null}
    </div>
  );
}
