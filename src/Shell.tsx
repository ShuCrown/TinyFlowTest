import { NavLink, Outlet, useLocation } from "react-router-dom";

const NAV = [
  { to: "/systems", label: "系统管理", code: "SYS" },
  { to: "/records", label: "操作记录", code: "REC" },
  { to: "/flows", label: "流程", code: "FLW" },
];

const CANVAS_PATH = /^\/flows\/[^/]+\/canvas\/?$/;

export function Shell() {
  const { pathname } = useLocation();
  const isCanvas = CANVAS_PATH.test(pathname);

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-[78px] shrink-0 flex-col border-r border-line bg-panel/95 backdrop-blur md:w-[86px]">
        <div className="flex h-[72px] items-center justify-center border-b border-line">
          <div className="grid h-10 w-10 place-items-center rounded-[12px] bg-gradient-to-br from-accent to-blue-700 text-[13px] font-bold tracking-[0.06em] text-white shadow-md shadow-accent/25">
            TF
          </div>
        </div>

        <nav className="flex flex-1 flex-col gap-1.5 px-2 py-4" aria-label="主导航">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `group relative flex flex-col items-center gap-1 rounded-xl py-2.5 transition-all ${
                  isActive
                    ? "bg-accent-soft font-semibold text-accent shadow-xs"
                    : "text-muted hover:bg-paper hover:text-ink"
                }`
              }
            >
              {({ isActive }) => (
                <>
                  {isActive ? (
                    <span className="absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r bg-accent" />
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
        className={`min-w-0 flex-1 ${isCanvas ? "px-3 py-3 lg:px-4 lg:py-4" : "px-4 py-4 md:px-6 lg:px-8"}`}
      >
        <div className="w-full">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
