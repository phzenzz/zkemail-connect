// 校验 app/src/lib/zkCrypto.ts 与 circuits/scripts/poseidon.ts 输出一致(防实现漂移)。
import { computeCommitment as refCommitment } from "../../circuits/scripts/poseidon";
import { sealEmailForRelayer as refSeal, relayerEmailHash } from "../../relayer/crypto";
import { computeCommitment, sealEmailForRelayer, fieldToBE32 } from "../src/react-app/lib/zkCrypto";
import nacl from "tweetnacl";

async function main() {
  const email = "Recipient.User+tag@Example.COM ";
  const mine = await computeCommitment(email);
  const ref = await refCommitment(email);
  if (mine !== ref) throw new Error(`commitment mismatch: ${mine} != ${ref}`);
  const refHashBytes = new Uint8Array(await relayerEmailHash(email));
  if (fieldToBE32(mine).some((x, i) => x !== refHashBytes[i]))
    throw new Error("fieldToBE32 mismatch vs relayerEmailHash");
  const kp = nacl.box.keyPair();
  const a = sealEmailForRelayer("a@b.com", kp.publicKey);
  const b = refSeal("a@b.com", kp.publicKey);
  if (a.length !== b.length) throw new Error("cipher len mismatch");
  // 非确定性加密(随机 ephemeral),只需长度/版本一致 + 可解密
  const opened = nacl.box.open(a.slice(57), a.subarray(33, 57), a.subarray(1, 33), kp.secretKey);
  if (!opened || new TextDecoder().decode(opened) !== "a@b.com") throw new Error("decrypt failed");
  if (fieldToBE32(256n)[30] !== 1 || fieldToBE32(256n)[31] !== 0) throw new Error("fieldToBE32 wrong");
  console.log("PARITY OK");
}
main().catch((e) => { console.error(e); process.exit(1); });
