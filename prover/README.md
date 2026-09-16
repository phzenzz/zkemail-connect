# prover — 容器化 rapidsnark 出证服务

把 `circuits/build/` 的电路产物挂载进容器，对外提供 HTTP 出证接口。容器内链路：
`node generate_witness.js claim.wasm input.json witness.wtns`（WASM witness，秒级）
→ `rapidsnark prover claim_final.zkey witness.wtns proof.json public.json`（原生多线程，主力耗时）。

## 构建与启动

```bash
npm run prover:up     # docker compose up -d --build prover
npm run prover:down   # docker compose down
```

首次构建较重：apt + clone rapidsnark（pinned commit）+ 源码编译 GMP 与 prover（x86_64 与 arm64 均支持，按 `TARGETARCH` 自动选择）。

## 接口

`GET /health` → `200 ok`

```bash
curl -s localhost:8080/health
```

`POST /prove`，body 为电路输入 JSON（即 `loadClaimEmail` 的 `inputs`）→
`200 { "proof": {...}, "publicSignals": [...], "ms": <耗时毫秒> }`。
proof / publicSignals 为 snarkjs `groth16 prove` 同构 JSON 格式，下游
`convertProofForSolana` 无需改动。出证失败返回 `500` + 错误消息。

```bash
curl -s -X POST localhost:8080/prove \
  -H 'content-type: application/json' \
  --data-binary @circuits/build/fixture-input.json \
  -o /tmp/prover-resp.json
```

## 产物挂载约定

`docker-compose.yml` 将 `./circuits/build` 以只读方式挂到容器内 `/artifacts`
（可用 `ARTIFACTS_DIR` 环境变量覆盖），server 启动时检查：

- `/artifacts/claim_js/claim.wasm`
- `/artifacts/claim_js/generate_witness.js`
- `/artifacts/claim_final.zkey`

## 资源建议

- 内存：`mem_limit: 12g`（claim 电路 ~3.4M 约束，rapidsnark 出证峰值约 8–12GB）。
- 出证是串行的：rapidsnark 非线程安全并发服务，server 内部用 Promise 链排队；
  横向扩容请加容器实例而不是调大并发。

## 实现备注

- rapidsnark pinned commit 见 `prover/Dockerfile` 头部注释；构建步骤以该 commit
  的 README（standalone Makefile 流程）为准。
- 真实往返（fixture-input → 证明 → snarkjs 交叉验证）在 `fixture-input.json`
  就绪后执行，见任务报告。
