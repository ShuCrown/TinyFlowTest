import { NavLink, Outlet, useLocation } from "react-router-dom";

const NAV = [
  { to: "/systems", label: "系统管理", code: "SYS" },
  { to: "/records", label: "操作记录", code: "REC" },
  { to: "/flows", label: "流程", code: "FLW" },
];

const WORKBENCH_PATH = /^\/records\/[^/]+\/record\/?$/;
const CANVAS_PATH = /^\/flows\/[^/]+\/canvas\/?$/;

export function Shell() {
  const { pathname } = useLocation();
  const isWorkbench = WORKBENCH_PATH.test(pathname);
  const isCanvas = CANVAS_PATH.test(pathname);
  const fullWidth = isWorkbench || isCanvas;

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-[78px] shrink-0 flex-col border-r border-line bg-panel/80 backdrop-blur md:w-[86px]">
        <div className="flex h-[96px] flex-col items-center justify-center border-b border-line">
          <div className="grid h-10 w-10 place-items-center rounded-[11px] bg-ink text-[13px] font-bold tracking-[0.06em] text-panel">
            TF
          </div>
          <div className="mt-2 font-mono text-[9px] uppercase tracking-[0.22em] text-accent">
            tinyflow
          </div>
        </div>

        <nav className="flex flex-1 flex-col gap-1 py-4" aria-label="主导航">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `group relative flex flex-col items-center gap-1 py-3 transition-colors ${
                  isActive ? "text-accent" : "text-muted hover:text-ink"
                }`
              }
            >
              {({ isActive }) => (
                <>
                  {isActive ? (
                    <span className="absolute left-0 top-1/2 h-7 w-[2px] -translate-y-1/2 bg-accent" />
                  ) : null}
                  <span className="font-mono text-[10px] tracking-[0.18em]">{item.code}</span>
                  <span className="text-[11px]">{item.label}</span>
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-line px-2 py-4 text-center">
          <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted">local</div>
          <div className="mt-1 font-mono text-[9px] tracking-[0.16em] text-muted/70">v0.1</div>
        </div>
      </aside>

      <main
        className={`min-w-0 flex-1 ${isCanvas ? "px-3 py-3 lg:px-4 lg:py-4" : "px-4 py-6 md:px-8 lg:px-10"}`}
      >
        <div className={`w-full ${fullWidth ? "" : "mx-auto max-w-[1180px]"}`}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}
