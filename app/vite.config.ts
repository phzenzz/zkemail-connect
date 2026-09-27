import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import path from "path";

export default defineConfig({
  plugins: [react(), cloudflare()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src/react-app"),
      // readable-stream 等 CJS 依赖以 `process/browser` 形式引用 process 浏览器垫片
      "process/browser": "process/browser.js",
    },
  },
  define: {
    global: "globalThis",
    "process.env": {},
  },
});
