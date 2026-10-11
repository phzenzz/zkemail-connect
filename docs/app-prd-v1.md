# zkEmail Connect — App 产品 PRD（v0.2 · 含设计规范）

> 状态：**本 PRD 即设计来源**——不再单独产出设计稿，开发以本文的线框图 + 设计 token + 组件规范直接实现。
> 技术底座：React + Vite + Hono + Cloudflare Workers + Tailwind + shadcn/ui（已就位）。
> 除「Send Claim」外各页面仅定义信息架构、线框与文案槽位；Send Claim 细节以现有实现为准。

---

## 1. 背景与目标

### 1.1 产品一句话

通过电子邮件发送 SPL 代币：发送方把代币锁进链上托管账户，接收方只需**回复中继邮件**（Subject 填入自己的 Solana 地址）即可领取，回复中的 DKIM 签名由 zkEmail Groth16 电路在链上验证——接收方不需要钱包插件之外的任何 Web3 操作。

### 1.2 当前状态

- MVP 合约 + 中继 + 证明器已在 **devnet 完成测试**。
- 前端已实现：`/send`（Send Claim）、`/claim/:escrow`（公开领币页）。
- 当前主题为 shadcn 默认 neutral 主题（见 §5.1，本期沿用不改色板）。

### 1.3 本 PRD 范围

1. **营销主页（占位）** — Home / Solution / Developer / Pricing，结构壳 + 文案槽位
2. **登录（本期实现）** — Google OAuth
3. **后台控制台（本期实现外壳）** — 左侧 Tab，本期仅挂已完成的 **Send Claim**

非目标：Solution 行业方案内容、定价模型、其余后台功能、mainnet、移动端专项优化。

---

## 2. 站点信息架构（Sitemap）

```
/                      → 营销主页 Home（占位）
/solutions             → Solution 列表页（占位）
/solutions/crm         → 方案占位：CRM
/solutions/payment     → 方案占位：Payment
/solutions/esign       → 方案占位：ESign
/developer             → 开发者文档入口（占位）
/pricing               → 定价占位

/login                 → 登录页（Google OAuth）          【本期实现】
/app                   → 后台控制台（登录守卫 → /app/send-claim）
/app/send-claim        → Send Claim（已有功能迁入）       【本期实现】
/claim/:escrow         → Claim 落地页（公开，无需登录，已有）
```

路由策略：

- `/send` → 301 重定向至 `/app/send-claim`。
- `/claim/:escrow` 保持公开。
- `/app/*` 未登录跳转 `/login?next=<原路径>`；本地开发 `VITE_SKIP_AUTH=1` 可关闭守卫。

---

## 3. 设计规范（Design System）

### 3.1 设计 Token —— 沿用现有 shadcn neutral 主题，零新增色板

基础 token 已在 `app/src/react-app/index.css` 定义，本期不改，仅约定用法：

| Token | 值（light） | 用途约定 |
|---|---|---|
| `background` | `0 0% 100%` | 营销页、登录页、内容区背景 |
| `foreground` | `0 0% 3.9%` | 主文字 |
| `primary` | `0 0% 9%`（近黑） | 主按钮、强调文字。**品牌色即黑**，不做彩色品牌色 |
| `muted-foreground` | `0 0% 45.1%` | 次级文字、占位说明 |
| `border` / `input` | `0 0% 89.8%` | 分割线、输入框描边 |
| `secondary` | `0 0% 96.1%` | 次级按钮、灰底卡片 |
| `destructive` | `0 84.2% 60.2%` | 错误提示、危险操作 |
| `sidebar-*` 系列 | shadcn 默认 | 后台侧边栏专用 token |
| `radius` | `0.5rem` | 全站圆角 lg；按钮/输入框用默认 |

- **Dark mode**：token 已齐备，本期默认跟随系统（`darkMode: ["class"]` 已配置），不单独做切换器。
- **强调色规则**：全站唯一允许的彩色是 `destructive`（错误）与成功态绿色（用 Tailwind `emerald-600` 文字 + `emerald-50` 底，仅用于交易成功/已领取等链上状态徽章）。营销区同样遵守。

### 3.2 字体与排版

| 用途 | 规格 |
|---|---|
| 全局字体 | 系统栈（沿用 shadcn 默认），不引入 Web Font |
| 营销页 H1 | `text-5xl md:text-6xl font-bold tracking-tight` |
| 营销页 H2 | `text-3xl md:text-4xl font-bold tracking-tight` |
| 后台页标题 | `text-2xl font-semibold tracking-tight` |
| 正文 | `text-sm md:text-base leading-relaxed text-muted-foreground` |
| 数字/地址 | `font-mono text-xs`（截断用 `truncate` + `title` 悬浮显示全文） |

### 3.3 布局栅格与间距

- 间距基数 4px（Tailwind 默认），区块纵向节奏：**营销区 section 之间 `py-20 md:py-28`**，后台卡片间距 `space-y-6`。
- 内容最大宽度：营销区 `max-w-6xl mx-auto px-6`；后台内容区不限制宽度（SendPage 原样渲染，零变更）。
- 卡片：`<Card>` 默认样式，`p-6` 内边距，无阴影或 `shadow-sm`（靠 border 分区，风格偏 Linear/Vercel 式扁平）。

### 3.4 组件规范（shadcn 已装组件直接用，无自研）

| 场景 | 组件 | 规格 |
|---|---|---|
| 主按钮 | `Button` default | 黑底白字，主 CTA 全站统一；hover 透明度 90% |
| 次级按钮 | `Button` variant=`outline` / `secondary` | 导航 CTA、表单次操作 |
| 表单 | `Input` / `Label` / `Select` | Label 在字段上方，`text-sm font-medium`；必填不标星，靠提交校验报错 |
| 链上地址 | 纯文本 mono + `title` | 表格内截断为前 8…后 8 |
| 状态徽章 | `Badge` | devnet → `secondary`；Success → emerald；Error → destructive |
| 加载 | `Button` 内 Spinner（`Loader2` lucide）+ `disabled` | 提交中按钮文案不变，图标转圈 |
| 空态 | 居中插画位（占位灰块 `h-24 w-24 rounded-lg bg-muted`）+ 一句说明 + 主按钮 | 列表为空统一此模式 |

### 3.5 关键状态模式

- **表单错误**：字段下方 `text-sm text-destructive`；链上失败显示 `Alert`（destructive 变体），文案含可复制的错误摘要。
- **交易进行中**：按钮 loading + 页面级不可重复提交（disabled 全部操作）。
- **交易成功**：结果用 `Card` 高亮区展示 + emerald 徽章，附 explorer 链接（devnet：`https://explorer.solana.com/tx/<sig>?cluster=devnet`）。

---

## 4. 页面设计（线框即最终实现标准）

### 4.1 营销区占位页（统一模板）

所有占位页共用一套最简模板——**居中单栏**，不为占位页单独设计：

```
┌──────────────────────────────────────────────┐
│  Logo        Solutions  Developer  Pricing   │  ← 顶栏：sticky, h-14, border-b
│                          [ Launch App ]      │     右侧主按钮跳 /login
├──────────────────────────────────────────────┤
│                                              │
│         <页面标题 H1>                        │
│         <一句话副标题 muted>                 │
│                                              │
│         [  占位内容区  ]                     │
│         卡片 / 三个方案入口卡片 /            │
│         Coming soon 徽章                     │
│                                              │
├──────────────────────────────────────────────┤
│  Footer: Solutions | Developer | Pricing     │  ← 文本链接 + © zkEmail Connect
│          + GitHub 图标链接                   │
└──────────────────────────────────────────────┘
```

- **Home `/`**：在统一模板上，占位内容区为 Hero 文案槽位（H1 = "Send crypto to any email address"，副标题 = "The recipient replies to an email to claim. No seed phrases, no onboarding."）+ 主 CTA [Launch App]。
- **Solutions `/solutions`**：占位内容区为 3 张卡片横排（`md:grid-cols-3`）——CRM / Payment / ESign，各卡：图标位（`lucide`: `Users` / `CreditCard` / `PenLine`）+ 标题 + 一句描述 + "Coming soon" Badge，整卡不可点。
- **三个子页 /developer /pricing**：仅标题 + 副标题 + "Coming soon" Badge。
- **文案语言**：营销区英文（对齐 README 语气）；后台 UI 文案本期也用英文（shadcn 生态惯例），后续可国际化。

### 4.2 登录页 `/login` 【本期实现】

居中卡片式，单栏，无侧边装饰：

```
┌──────────────────────────────────────────────┐
│  Logo                         (无导航)       │
│                                              │
│            ┌────────────────────┐            │
│            │  ◆ 品牌 Logo 48px  │            │
│            │                    │            │
│            │  Welcome to        │            │  H1: text-2xl font-semibold
│            │  zkEmail Connect   │            │
│            │  <muted 副标题一句>│            │
│            │                    │            │
│            │  [ G  Sign in with Google ]    │  Button default, 全宽, h-11
│            │                    │            │
│            │  By continuing...  │            │  text-xs muted 条款占位文本
│            └────────────────────┘            │
│            Card: max-w-sm mx-auto            │
└──────────────────────────────────────────────┘
```

- 交互：点击按钮 → Worker 发起 Google OAuth（302 跳转）；成功后回跳 `?next=`（默认 `/app/send-claim`）。
- 态：回调失败回 `/login?error=oauth_failed` → 卡片顶部显示 destructive `Alert` "Sign-in failed, please try again."。
- 已登录访问 `/login` → 直接跳 `next`。

### 4.3 后台 AppShell `/app` 【本期实现】

```
┌──────────┬───────────────────────────────────────────┐
│  ◆ Logo  │  Send Claim          [devnet Badge]  👤  │ ← 顶栏 h-14 border-b
│          │                      头像菜单(钱包按钮留在页面内) │
│──────────┤───────────────────────────────────────────┤
│ ▸ Send   │        <页面内容>                        │
│   Claim  │        直接渲染现有 SendPage，           │
│          │        不做布局改动                     │
│ [用户区]  │                                           │
│  avatar  │                                           │
│  邮箱     │                                           │
│  Sign out │                                           │
└──────────┴───────────────────────────────────────────┤
 侧边栏 w-60                                           
 border-r sidebar 背景                                 
```

规格：

- **侧边栏**：`w-60`（240px），`sidebar-background`，`border-r`。**本期只有一个导航项** Send Claim（图标 lucide `Send`，size 16，激活态 `sidebar-accent` 底 + `font-medium`）；不放任何 Coming soon 占位项。后续新增 Tab 时直接往导航列表加项，内容区渲染对应页面组件即可。
- **顶栏**：左侧当前页标题（`text-lg font-semibold`）；右侧依次：`devnet` Badge（`secondary`）、用户头像 Dropdown（头像 + 邮箱 + Sign out）。钱包连接按钮**留在 SendPage 内不动**（页面零变更原则）。
- **内容区**：`p-6 lg:p-8`，滚动发生在内容区，侧栏/顶栏固定。
- **响应式**：< `lg` 时侧边栏收为可抽屉（`Sheet` 组件，汉堡按钮在顶栏左侧）；本期实现即可，无需打磨。
- **数据获取**：AppShell 挂载时调 `/api/me`；401 → 跳 `/login?next=`。

### 4.4 Send Claim `/app/send-claim`（已有功能，直接复用）

**Send / Claim 页面本期均不做任何布局与视觉变更。** Tab 切换 = 侧边栏选中项变化 + 右侧内容区直接渲染现有页面组件：

- **Send**：内容区原样渲染现有 `SendPage.tsx`（含页面自带标题与卡片），不套新布局、不重排、不收敛样式。
- **Claim**：现有 `ClaimPage.tsx` 保持在公开路由 `/claim/:escrow` 不变，不进后台 Tab。

Tab 切换机制约定（为后续扩展预留）：侧边栏选中项驱动内容区渲染对应路由的页面组件（本期仅一项，实为静态）；路由仍一一对应（`/app/send-claim`），刷新后按 URL 恢复选中态。

验收：迁移前后像素级一致，仅外层多了 AppShell 边框与顶栏。

### 4.5 Claim 落地页 `/claim/:escrow`（已有，公开）

- Claim 页本期不要求变更。可选（M4，低优先）：加最薄页头——左 Logo（链接回 `/`）、右 [Launch App] 按钮，与营销区顶栏同款；claim 流程本体不动。

---

## 5. 用户流程（本期）

```
访客 → 主页(占位) → [Launch App]
  ├─ 未登录 → /login (Google OAuth) → 回跳 /app/send-claim
  ├─ 已登录 → /app/send-claim → 连接钱包 → 创建托管 → 复制 claim 链接
  │           → 接收方打开 /claim/:escrow → 回复中继邮件 → 链上验证领币
  └─ 浏览 Solutions / Developer / Pricing（占位）
```

---

## 6. 技术方案要点（本期新增）

| 模块 | 方案 |
|---|---|
| 路由 | react-router-dom：营销路由组 + `/app` 受保护路由组（Outlet 守卫） |
| Google OAuth | Worker 端授权码流程；会话随机 token 存 KV，HttpOnly Cookie；`/api/me` 返回用户态 |
| 登录守卫 | 前端 Outlet + Worker 校验 Cookie 双保险 |
| 布局 | `AppShell` 组件（Sidebar + Topbar + Outlet），SendPage 作子路由 |
| 环境标识 | devnet Badge 常驻顶栏 |

## 7. 里程碑拆分

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 | 路由重组 + AppShell + SendPage 迁入 + 旧路由重定向 | `/app/send-claim` 功能与迁移前一致；`/send` 301 |
| M2 | Google OAuth + 登录守卫 + `/api/me` + 顶栏用户态 | 未登录访问 `/app/*` 跳 `/login` 并可回跳 |
| M3 | 营销占位页（统一占位模板 + Home Hero 文案 + Solutions 三卡） | 营销路由全部可访问 |
| M4 | Claim 页页头对齐（可选，低优先——用户已表示 claim 页不要求变更） | 页头含 Logo + Launch App |

## 8. 暂不处理（Out of Scope）

- Solution 三方案内容、定价模型
- 侧边栏新增 Tab（需后续版本定义）
- mainnet、移动端专项打磨、深色模式切换器
- 营销区视觉升级（插画/动效）——占位期结束后另立项
