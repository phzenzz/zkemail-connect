import { describe, expect, it, jest } from "@jest/globals";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { buildAltAddressList } from "../../../relayer/claimer";

// rpc-websockets 的嵌套依赖 uuid@14 为纯 ESM,jest 默认不转换 node_modules 而解析失败;
// 运行时 Node 20.19+ 的 require(esm) 正常。本测试不建立 websocket 连接,
// 故顶替 rpc-websockets 以避免加载 uuid(与 inbound.test.ts 同款)。
jest.mock("rpc-websockets", () => ({
  Client: class {},
  CommonClient: class {},
  WebSocketClient: class {},
}));

describe("buildAltAddressList", () => {
  it("returns exactly the 13 addresses in e2e order", () => {
    const x = {
      programId: Keypair.generate().publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      ataProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      mint: Keypair.generate().publicKey,
      escrow: Keypair.generate().publicKey,
      vault: Keypair.generate().publicKey,
      sender: Keypair.generate().publicKey,
      registry: Keypair.generate().publicKey,
      destOwner: Keypair.generate().publicKey,
      destAta: Keypair.generate().publicKey,
      nullifier: Keypair.generate().publicKey,
      protocolConfig: Keypair.generate().publicKey,
    };
    const list = buildAltAddressList(x);
    expect(list).toHaveLength(13);
    expect(list[0].toBase58()).toBe(x.programId.toBase58());
    expect(list[12].toBase58()).toBe(x.protocolConfig.toBase58());
    expect(list).toEqual([
      x.programId, x.systemProgram, x.tokenProgram, x.ataProgram,
      x.mint, x.escrow, x.vault, x.sender, x.registry, x.destOwner,
      x.destAta, x.nullifier, x.protocolConfig,
    ]);
  });
});
