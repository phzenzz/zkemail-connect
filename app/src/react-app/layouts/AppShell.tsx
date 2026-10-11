import type { CSSProperties } from "react";
import { Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { HandCoins, LogOut, Send } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Logo } from "@/components/Logo";
import { useAuth, type AuthUser } from "@/lib/auth";

/** 后续新增 Tab 时往这里加项即可；内容区由 <Outlet> 渲染对应路由页面。 */
const NAV = [
  { to: "/app/send-claim", label: "Send", icon: Send },
  { to: "/app/claim", label: "Claim", icon: HandCoins },
] as const;

/** PRD 要求 w-60(240px)；shadcn 默认 16rem(256px)。 */
const SIDEBAR_STYLE = { "--sidebar-width": "15rem" } as CSSProperties;

function initialsOf(user: AuthUser): string {
  const source = user.name?.trim() || user.email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

function UserAvatar({ user, className }: { user: AuthUser; className?: string }) {
  return (
    <Avatar className={className}>
      <AvatarImage src={user.picture ?? undefined} alt="" />
      <AvatarFallback className="text-xs">{initialsOf(user)}</AvatarFallback>
    </Avatar>
  );
}

export default function AppShell() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const auth = useAuth();
  const user = auth.status === "authed" ? auth.user : null;

  const title = NAV.find((item) => pathname.startsWith(item.to))?.label ?? "zkEmail Connect";

  const signOut = async () => {
    await auth.signOut();
    navigate({ to: "/login", search: {}, replace: true });
  };

  return (
    <SidebarProvider className="h-svh overflow-hidden" style={SIDEBAR_STYLE}>
      <Sidebar collapsible="offcanvas">
        <SidebarHeader className="h-14 justify-center border-b px-4">
          <Link to="/" aria-label="zkEmail Connect — home">
            <Logo />
          </Link>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {NAV.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton asChild isActive={pathname.startsWith(item.to)}>
                      <Link to={item.to}>
                        <item.icon size={16} />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        {user && (
          <SidebarFooter className="border-t">
            <div className="flex items-center gap-2 px-1 py-1">
              <UserAvatar user={user} className="h-8 w-8" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium" title={user.email}>
                  {user.email}
                </p>
                <button
                  type="button"
                  onClick={() => void signOut()}
                  className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  Sign out
                </button>
              </div>
            </div>
          </SidebarFooter>
        )}
      </Sidebar>

      <SidebarInset className="flex min-w-0 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4 lg:px-6">
          {/* 仅 <lg 显示：桌面端侧栏常驻，不做折叠按钮（PRD §4.3） */}
          <SidebarTrigger className="lg:hidden" />
          <h1 className="truncate text-lg font-semibold">{title}</h1>
          <div className="ml-auto flex items-center gap-3">
            <Badge variant="secondary">devnet</Badge>
            {user && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  aria-label="Account menu"
                >
                  <UserAvatar user={user} className="h-8 w-8" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel className="font-normal">
                    <p className="truncate text-sm font-medium">{user.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => void signOut()}>
                    <LogOut className="mr-2 h-4 w-4" />
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </header>

        <div className="flex-1 overflow-auto p-6 lg:p-8">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
