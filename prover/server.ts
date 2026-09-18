import http from "http";
import fs from "fs";
import { execFileSync } from "child_process";

const ART = process.env.ARTIFACTS_DIR ?? "/artifacts";
const PORT = Number(process.env.PORT ?? 8080);
const WASM = `${ART}/claim_js/claim.wasm`;
const WITNESS_GEN = `${ART}/claim_js/generate_witness.js`;
const WITNESS_CALC = `${ART}/claim_js/witness_calculator.js`;
const ZKEY = `${ART}/claim_final.zkey`;

for (const f of [WASM, WITNESS_GEN, WITNESS_CALC, ZKEY]) {
  if (!fs.existsSync(f)) { console.error(`missing artifact: ${f}`); process.exit(1); }
}

// rapidsnark 不是线程安全的并发服务：简单 Promise 链串行化出证请求
let queue: Promise<unknown> = Promise.resolve();

function prove(inputs: unknown): { proof: unknown; publicSignals: unknown; ms: number } {
  const t0 = Date.now();
  fs.writeFileSync("/tmp/input.json", JSON.stringify(inputs));
  execFileSync("node", [WITNESS_GEN, WASM, "/tmp/input.json", "/tmp/witness.wtns"],
    { maxBuffer: 64 * 1024 * 1024 });
  execFileSync("/usr/local/bin/prover", [ZKEY, "/tmp/witness.wtns", "/tmp/proof.json", "/tmp/public.json"],
    { maxBuffer: 64 * 1024 * 1024 });
  return {
    proof: JSON.parse(fs.readFileSync("/tmp/proof.json", "utf8")),
    publicSignals: JSON.parse(fs.readFileSync("/tmp/public.json", "utf8")),
    ms: Date.now() - t0,
  };
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") { res.end("ok"); return; }
  if (req.method === "POST" && req.url === "/prove") {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("error", (e) => {
      // 客户端中断/ socket 错误：未发送头部则回 400，否则仅记录并断开，不能让进程崩掉
      console.error(`[prover] request error: ${String((e as Error)?.message ?? e)}`);
      if (!res.headersSent) { res.statusCode = 400; res.end(String((e as Error)?.message ?? e)); }
      else res.destroy();
    });
    req.on("end", () => {
      queue = queue.then(() => {
        try {
          const inputs = JSON.parse(Buffer.concat(chunks).toString());
          const result = prove(inputs);
          console.log(`[prover] proof generated in ${result.ms}ms`);
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(result));
        } catch (e: any) {
          res.statusCode = 500;
          res.end(String(e?.message ?? e));
        }
      });
    });
    return;
  }
  res.statusCode = 404; res.end();
});
server.listen(PORT, () => console.log(`[prover] listening on :${PORT}`));
