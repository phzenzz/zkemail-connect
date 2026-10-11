import "./polyfill";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

// 注意：SolanaProviders 不在这里。它需要 /api/config 才能建立 RPC 与钱包连接，
// 挂在最外层会让营销页、登录页这些完全不依赖 Solana 的路由一起被它的加载态挡住。
// 现在只包住真正用到链的 /app/send-claim 与 /claim/:escrow（见 App.tsx）。
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
