import { useEffect, useId, type ReactNode } from "react";

export function PageHeader({
  code,
  title,
  description,
  actions,
}: {
  code: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
      <div className="min-w-0">
        <span className="tf-kicker">{code}</span>
        <h1 className="tf-display mt-1 text-[26px] leading-tight">{title}</h1>
        {description ? (
          <p className="mt-1.5 max-w-[760px] text-[12.5px] leading-5 text-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "neutral" | "accent" | "moss" | "amber";
}) {
  const dot: Record<string, string> = {
    neutral: "bg-muted/50",
    accent: "bg-accent",
    moss: "bg-moss",
    amber: "bg-amber",
  };
  return (
    <div className="tf-panel px-4 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted">{label}</span>
        <span className={`h-1.5 w-1.5 rounded-full ${dot[tone]}`} />
      </div>
      <div className="mt-1 text-[22px] font-semibold leading-tight tracking-tight">{value}</div>
      {hint ? <div className="mt-1 text-[11.5px] leading-4 text-muted">{hint}</div> : null}
    </div>
  );
}

export function EmptyState({
  code,
  title,
  description,
  action,
  children,
}: {
  code: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="tf-empty flex flex-col items-center px-6 py-12 text-center">
      <div className="grid h-11 w-11 place-items-center rounded-[12px] border border-line bg-white font-mono text-[11px] font-semibold tracking-[0.14em] text-accent">
        {code}
      </div>
      <h2 className="mt-4 text-[15px] font-semibold tracking-tight">{title}</h2>
      {description ? (
        <p className="mt-1.5 max-w-[520px] text-[12.5px] leading-5 text-muted">{description}</p>
      ) : null}
      {children ? <div className="mt-6 w-full">{children}</div> : null}
      {action ? <div className="mt-6">{action}</div> : null}
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="text-[12px] font-medium text-ink">{label}</span>
      {children}
      {hint ? <span className="text-[11px] leading-4 text-muted">{hint}</span> : null}
    </label>
  );
}

export function Dialog({
  open,
  title,
  description,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="tf-dialog-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="tf-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 id={titleId} className="text-[16px] font-semibold tracking-tight">
              {title}
            </h2>
            {description ? (
              <p className="mt-1 text-[12px] leading-5 text-muted">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line bg-white text-[16px] leading-none text-muted transition-colors hover:text-ink"
            aria-label="关闭"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer ? (
          <div className="flex justify-end gap-2 border-t border-line px-5 py-3.5">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}
