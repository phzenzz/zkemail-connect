// 01: 解析真实 .eml（真实 DNS 验 DKIM、48h 新鲜度、To/Subject 校验），
//     把 commitment / selector / dest 等元数据存入 .manual-test/state.json。
//     relayer 公钥会绑定进电路输入，后续 prove/claim 必须用同一个 relayer.json。
import fs from "fs";
import { loadClaimEmail } from "../../circuits/scripts/load-email";
import { relayerToField } from "../../circuits/scripts/poseidon";
import { EML, loadKeypair, saveState } from "./common";

async function main() {
  if (!fs.existsSync(EML)) {
    throw new Error(`缺少测试邮件 ${EML} —— .eml 不入库，先按 circuits/testdata/emails/README.md 导出一份`);
  }
  const relayer = loadKeypair("relayer");
  const email = await loadClaimEmail(EML, relayerToField(relayer.publicKey.toBytes()));
  saveState({ meta: email.meta as unknown as Record<string, unknown> });
  console.log(`[01] from=${email.meta.fromEmail} domain=${email.meta.domain} selector=${email.meta.selector}`);
  console.log(`[01] dest(Subject)=${email.meta.destBase58}`);
  console.log(`[01] commitment=${email.meta.commitment}`);
}
main().catch((e) => { console.error("[01] FAIL:", e?.message ?? e); process.exit(1); });
