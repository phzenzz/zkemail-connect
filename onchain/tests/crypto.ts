import { assert } from "chai";
import nacl from "tweetnacl";
import { computeCommitment } from "../../circuits/scripts/poseidon";
import { fieldToBE } from "./helpers";
import { sealEmailForRelayer, openEmailCipher, relayerEmailHash } from "../../relayer/crypto";

describe("email sealed-box crypto", () => {
  const relayer = nacl.box.keyPair();
  const EMAIL = "Receiver@Example.com";

  it("seal → open round-trips and matches Poseidon commitment", async () => {
    const blob = sealEmailForRelayer(EMAIL, relayer.publicKey);
    assert.equal(blob[0], 1);                    // version
    assert.isAtMost(blob.length, 121);           // MAX_CIPHER_LEN
    const opened = openEmailCipher(blob, relayer.secretKey);
    assert.equal(opened, EMAIL);                 // 大小写原样恢复
    // 与 commitment 同一哈希函数
    const commitment = fieldToBE((await computeCommitment(EMAIL)).toString());
    assert.deepEqual([...(await relayerEmailHash(EMAIL))], [...commitment]);
    assert.equal((await relayerEmailHash(EMAIL)).length, 32);
  });

  it("wrong key and tampered blob fail to open", async () => {
    const blob = sealEmailForRelayer(EMAIL, relayer.publicKey);
    const other = nacl.box.keyPair();
    assert.isNull(openEmailCipher(blob, other.secretKey));
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 0xff;
    assert.isNull(openEmailCipher(tampered, relayer.secretKey));
  });
});
