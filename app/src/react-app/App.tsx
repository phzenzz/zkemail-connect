import { createRootRoute, createRoute, createRouter, Navigate, Outlet, RouterProvider, redirect } from "@tanstack/react-router";
import { AuthProvider, RequireAuth } from "./lib/auth";
import { SolanaProviders } from "./lib/solana";
import MarketingLayout from "./layouts/MarketingLayout";
import AppShell from "./layouts/AppShell";
import Home from "./pages/marketing/Home";
import Solutions from "./pages/marketing/Solutions";
import SolutionDetail from "./pages/marketing/SolutionDetail";
import Developer from "./pages/marketing/Developer";
import Pricing from "./pages/marketing/Pricing";
import LoginPage from "./pages/LoginPage";
import SendPage from "./pages/SendPage";
import ClaimPage from "./pages/ClaimPage";
import ClaimList from "./pages/ClaimList";
import "./App.css";

const rootRoute = createRootRoute({
  component: () => (
    <div className="min-h-screen bg-background text-foreground">
      <Outlet />
    </div>
  ),
  // 未知路径回首页（PRD 未定义 404 页，不新增）
  notFoundComponent: () => <Navigate to="/" replace />,
});

// 营销区：无路径布局路由（只有 id 没有 path），子路由写完整路径
const marketingRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "marketing",
  component: MarketingLayout,
});
const homeRoute = createRoute({ getParentRoute: () => marketingRoute, path: "/", component: Home });
const solutionsRoute = createRoute({ getParentRoute: () => marketingRoute, path: "/solutions", component: Solutions });
const solutionDetailRoute = createRoute({
  getParentRoute: () => marketingRoute,
  path: "/solutions/$slug",
  component: SolutionDetail,
});
const developerRoute = createRoute({ getParentRoute: () => marketingRoute, path: "/developer", component: Developer });
const pricingRoute = createRoute({ getParentRoute: () => marketingRoute, path: "/pricing", component: Pricing });

export type LoginSearch = { next?: string; error?: string };

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    next: typeof search.next === "string" ? search.next : undefined,
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  component: LoginPage,
});

// 公开：无守卫。链上读取代币信息，需要 Solana provider
const claimRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/claim/$escrow",
  component: () => (
    <SolanaProviders>
      <ClaimPage />
    </SolanaProviders>
  ),
});

// 后台：/app 带 path，子路由相对父级拼接（"/" 解析为 /app 自身，即索引）
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app",
  component: () => (
    <RequireAuth>
      <AppShell />
    </RequireAuth>
  ),
});
const appIndexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/app/send-claim" });
  },
});
const sendClaimRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "send-claim",
  component: () => (
    <SolanaProviders>
      <SendPage />
    </SolanaProviders>
  ),
});

// 后台 Claim Tab：列表按当前登录邮箱筛选可领取的托管
const claimTabRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "claim",
  component: () => (
    <SolanaProviders>
      <ClaimList />
    </SolanaProviders>
  ),
});
// 选中某笔后走现有 ClaimPage（输入钱包地址 → 生成领取邮件），组件零改动
const claimTabDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "claim/$escrow",
  component: () => (
    <SolanaProviders>
      <ClaimPage />
    </SolanaProviders>
  ),
});

// Worker 侧 /send 已发真 301（见 src/worker/index.ts），这里是 SPA 内兜底
const sendRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/send",
  beforeLoad: () => {
    throw redirect({ to: "/app/send-claim" });
  },
});

const routeTree = rootRoute.addChildren([
  marketingRoute.addChildren([homeRoute, solutionsRoute, solutionDetailRoute, developerRoute, pricingRoute]),
  loginRoute,
  claimRoute,
  appRoute.addChildren([appIndexRoute, sendClaimRoute, claimTabRoute, claimTabDetailRoute]),
  sendRedirectRoute,
]);

const router = createRouter({ routeTree });

// 让 Link / useParams / Navigate 拿到全量路由字面量类型
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export default function App() {
  return (
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  );
}
