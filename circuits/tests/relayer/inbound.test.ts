import { describe, expect, it, jest } from "@jest/globals";
import { Connection, Keypair } from "@solana/web3.js";
import { extractFromAndSubject, findOpenEscrow, runInbound } from "../../../relayer/inbound";

// rpc-websockets 的嵌套依赖 uuid@14 为纯 ESM,jest 默认不转换 node_modules 而解析失败;
// 运行时 Node 20.19+ 的 require(esm) 正常。本测试只用 Connection/Keypair(不走 websocket),
// 故顶替 rpc-websockets 以避免加载 uuid。
jest.mock("rpc-websockets", () => ({
  Client: class {},
  CommonClient: class {},
  WebSocketClient: class {},
}));

describe("extractFromAndSubject", () => {
  it("parses folded headers and addr-spec", () => {
    const raw = Buffer.from(
      "From: Bob Example <bob@Gmail.com>\r\n" +
      "To: penghe1996@gmail.com\r\n" +
      "Subject: 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb8ySdfgz1\r\n" +
      "\r\nbody"
    );
    const r = extractFromAndSubject(raw);
    expect(r).not.toBeNull();
    expect(r!.fromEmail).toBe("bob@gmail.com");
    expect(r!.subject).toBe("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb8ySdfgz1");
  });

  it("unfolds subject continuation lines", () => {
    const raw = Buffer.from("From: a@b.com\r\nSubject: Abc\r\n  Def\r\n\r\n");
    expect(extractFromAndSubject(raw)!.subject).toBe("Abc Def");
  });

  it("rejects missing headers", () => {
    expect(extractFromAndSubject(Buffer.from("Subject: x\r\n\r\n"))).toBeNull();
  });
});

describe("findOpenEscrow", () => {
  it("queries with size+memcmp filters and returns first", async () => {
    const programId = Keypair.generate().publicKey;
    const escrow = Keypair.generate().publicKey;
    const conn = {
      getProgramAccounts: jest.fn<(...args: any[]) => any>().mockResolvedValue([{ pubkey: escrow }]),
    } as unknown as Connection;
    const got = await findOpenEscrow(conn, programId, new Uint8Array(32));
    expect(got).toEqual(escrow);
    const callArgs = (conn.getProgramAccounts as jest.Mock).mock.calls[0] as any[];
    expect(callArgs[0]).toEqual(programId);
    expect(callArgs[1].filters).toHaveLength(2);
    expect(callArgs[1].filters[0]).toEqual({ dataSize: 286 });
    expect(callArgs[1].filters[1].memcmp.offset).toBe(8);
    expect(typeof callArgs[1].filters[1].memcmp.bytes).toBe("string");
  });
});

describe("runInbound", () => {
  it("searches unseen by UID so seq numbers are never used as UIDs", async () => {
    const search = jest.fn<(...args: any[]) => any>().mockResolvedValue([]);
    const client = {
      connect: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
      getMailboxLock: jest.fn<(...args: any[]) => any>().mockResolvedValue({ release: jest.fn() }),
      fetchOne: jest.fn<(...args: any[]) => any>(),
      messageFlagsAdd: jest.fn<(...args: any[]) => any>(),
      search,
      logout: jest.fn<(...args: any[]) => any>(),
    };
    const deps = {
      connection: {} as unknown as Connection,
      programId: Keypair.generate().publicKey,
      notifier: { notify: jest.fn<(...args: any[]) => any>() },
      onClaimable: jest.fn<(...args: any[]) => any>(),
      pollMs: 60_000, // 长驻循环不退出;首轮断言后即可结束测试
    };
    void runInbound(deps, client);
    await new Promise((r) => setImmediate(r)); // 等首轮轮询执行完
    expect(search).toHaveBeenCalledWith({ unseen: true }, { uid: true });
  });
});
