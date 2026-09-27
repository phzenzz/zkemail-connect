import { Link, Outlet } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";

const NAV = [
  { to: "/solutions", label: "Solutions" },
  { to: "/developer", label: "Developer" },
  { to: "/pricing", label: "Pricing" },
] as const;

/**
 * Launch App 指向 /app/send-claim 而非 /login：未登录时 RequireAuth 会带上
 * next 跳登录页，已登录则直达，两条路径都收敛，且保留深链目标（PRD §5）。
 */
const LAUNCH_APP = "/app/send-claim";

export default function MarketingLayout() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 h-14 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex h-full max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-8">
            <Link to="/" aria-label="zkEmail Connect — home">
              <Logo />
            </Link>
            <nav className="hidden items-center gap-6 md:flex">
              {NAV.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  className="text-sm transition-colors hover:text-foreground"
                  // 基类不设颜色，由 inactive/active 各给一套，避免 Tailwind 同属性冲突
                  inactiveProps={{ className: "text-muted-foreground" }}
                  activeProps={{ className: "font-medium text-foreground" }}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
          <Button asChild size="sm">
            <Link to={LAUNCH_APP}>Launch App</Link>
          </Button>
        </div>
      </header>

      <main className="flex-1">
        <Outlet />
      </main>

      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-8 md:flex-row">
          <nav className="flex items-center gap-6">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className="text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <p className="text-sm text-muted-foreground">© {new Date().getFullYear()} zkEmail Connect</p>
        </div>
      </footer>
    </div>
  );
}
