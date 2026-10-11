import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./relayer/store/schema.ts",
  out: "./relayer/store/migrations",
  dbCredentials: { url: "./relayer/data/relayer.db" },
});
