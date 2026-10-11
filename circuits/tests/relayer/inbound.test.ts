import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { Connection, Keypair } from "@solana/web3.js";
import { extractFromAndSubject, findOpenEscrow, runInbound, runInboundFromEnv } from "../../../relayer/inbound";

// rpc-websockets 的嵌套依赖 uuid@14 为纯 ESM,jest 默认不转换 node_modules 而解析失败;
// 运行时 Node 20.19+ 的 require(esm) 正常。本测试只用 Connection/Keypair(不走 websocket),
// 故顶替 rpc-websockets 以避免加载 uuid。
jest.mock("rpc-websockets", () => ({
  Client: class {},
  CommonClient: class {},
  WebSocketClient: class {},
}));

// runInboundFromEnv 的 env 选择测试:顶替 imapflow,记录构造参数(静态 instances 暴露给用例)。
jest.mock("imapflow", () => ({
  ImapFlow: class MockImapFlow {
    static instances: Array<{ opts: any }> = [];
    opts: any;
    constructor(opts: any) {
      this.opts = opts;
      (this.constructor as typeof MockImapFlow).instances.push(this);
    }
    connect = async () => {};
    getMailboxLock = async () => ({ release: () => {} });
    fetchOne = async () => undefined;
    messageFlagsAdd = async () => undefined;
    search = async () => [];
    logout = async () => {};
  },
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

  const waitFor = async (cond: () => boolean, ms = 3000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error("waitFor timeout");
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it("marks \\Seen even when the mail is ignored (guidance reply must not retry)", async () => {
    const eml = Buffer.from("From: a@b.com\r\nSubject: not-a-base58-address\r\n\r\n");
    const search = jest.fn<(...args: any[]) => any>()
      .mockImplementation((q: any) => Promise.resolve(q?.all ? [] : [3]));
    const fetchOne = jest.fn<(...args: any[]) => any>().mockResolvedValue({ source: eml });
    const messageFlagsAdd = jest.fn<(...args: any[]) => any>();
    const notifier = { notify: jest.fn<(...args: any[]) => any>() };
    const client = {
      connect: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
      getMailboxLock: jest.fn<(...args: any[]) => any>().mockResolvedValue({ release: jest.fn() }),
      fetchOne,
      messageFlagsAdd,
      search,
      logout: jest.fn<(...args: any[]) => any>(),
    };
    const deps = {
      connection: {} as unknown as Connection,
      programId: Keypair.generate().publicKey,
      notifier,
      onClaimable: jest.fn<(...args: any[]) => any>(),
      pollMs: 60_000,
    };
    void runInbound(deps, client);
    await waitFor(() => messageFlagsAdd.mock.calls.length > 0);
    expect(notifier.notify).toHaveBeenCalledTimes(1); // 引导回信已发
    expect(messageFlagsAdd).toHaveBeenCalledWith("3", ["\\Seen"], { uid: true }); // 不再重试
  });

  it("does not send guidance for the relay's own mail (breaks self-notification loop)", async () => {
    process.env.RELAYER_EMAIL = "relay@x.io";
    try {
      // 复刻线上循环：通知/引导信 From = relay 自身、主题非 base58 → 不得再回引导
      const eml = Buffer.from(
        "From: Token Airdrop <relay@x.io>\r\nSubject: You received  tokens — reply to claim\r\n\r\n");
      const search = jest.fn<(...args: any[]) => any>()
        .mockImplementation((q: any) => Promise.resolve(q?.all ? [] : [3]));
      const fetchOne = jest.fn<(...args: any[]) => any>().mockResolvedValue({ source: eml });
      const messageFlagsAdd = jest.fn<(...args: any[]) => any>();
      const notifier = { notify: jest.fn<(...args: any[]) => any>() };
      const client = {
        connect: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
        getMailboxLock: jest.fn<(...args: any[]) => any>().mockResolvedValue({ release: jest.fn() }),
        fetchOne,
        messageFlagsAdd,
        search,
        logout: jest.fn<(...args: any[]) => any>(),
      };
      const deps = {
        connection: {} as unknown as Connection,
        programId: Keypair.generate().publicKey,
        notifier,
        onClaimable: jest.fn<(...args: any[]) => any>(),
        pollMs: 60_000,
      };
      void runInbound(deps, client);
      await waitFor(() => messageFlagsAdd.mock.calls.length > 0);
      expect(notifier.notify).not.toHaveBeenCalled(); // 自举循环在此切断
      expect(messageFlagsAdd).toHaveBeenCalledWith("3", ["\\Seen"], { uid: true });
    } finally {
      delete process.env.RELAYER_EMAIL;
    }
  });

  it("startup watermark: first poll skips historical UNSEEN uids <= watermark", async () => {
    const eml = Buffer.from("From: a@b.com\r\nSubject: not-a-base58-address\r\n\r\n");
    let unseenPolls = 0;
    const search = jest.fn<(...args: any[]) => any>().mockImplementation((q: any) => {
      if (q?.all) return Promise.resolve([500]);
      unseenPolls += 1;
      return Promise.resolve(unseenPolls === 1 ? [499, 500, 501, 502] : []);
    });
    const fetchOne = jest.fn<(...args: any[]) => any>().mockResolvedValue({ source: eml });
    const messageFlagsAdd = jest.fn<(...args: any[]) => any>();
    const client = {
      connect: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined),
      getMailboxLock: jest.fn<(...args: any[]) => any>().mockResolvedValue({ release: jest.fn() }),
      fetchOne,
      messageFlagsAdd,
      search,
      logout: jest.fn<(...args: any[]) => any>(),
    };
    const deps = {
      connection: {} as unknown as Connection,
      programId: Keypair.generate().publicKey,
      notifier: { notify: jest.fn<(...args: any[]) => any>() },
      onClaimable: jest.fn<(...args: any[]) => any>(),
      pollMs: 60_000,
    };
    void runInbound(deps, client);
    await waitFor(() => messageFlagsAdd.mock.calls.length >= 2);
    expect(fetchOne.mock.calls.map((c) => c[0])).toEqual(["501", "502"]);
  });
});

describe("runInboundFromEnv", () => {
  const ORIGINAL_ENV = process.env;
  const ORIGINAL_FETCH = globalThis.fetch;
  let fetchMock: jest.Mock;

  beforeEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.GMAIL_OAUTH_CLIENT_ID;
    delete process.env.GMAIL_OAUTH_CLIENT_SECRET;
    delete process.env.GMAIL_OAUTH_REFRESH_TOKEN;
    delete process.env.GMAIL_APP_PASSWORD;
    fetchMock = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "access-tok", expires_in: 3600 }),
    });
    (globalThis as any).fetch = fetchMock;
    const { ImapFlow } = await import("imapflow");
    (ImapFlow as any).instances.length = 0;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    (globalThis as any).fetch = ORIGINAL_FETCH;
  });

  const deps = () => ({
    connection: {} as unknown as Connection,
    programId: Keypair.generate().publicKey,
    notifier: { notify: jest.fn<(...args: any[]) => any>() },
    onClaimable: jest.fn<(...args: any[]) => any>(),
    pollMs: 60_000,
  });

  async function imapInstances() {
    const { ImapFlow } = await import("imapflow");
    return (ImapFlow as any).instances as Array<{ opts: any }>;
  }

  it("constructs ImapFlow with XOAUTH2 access token when oauth2 env present", async () => {
    process.env.RELAYER_EMAIL = "relayer@gmail.com";
    process.env.GMAIL_OAUTH_CLIENT_ID = "cid";
    process.env.GMAIL_OAUTH_CLIENT_SECRET = "csec";
    process.env.GMAIL_OAUTH_REFRESH_TOKEN = "rt";
    void runInboundFromEnv(deps());
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init.method).toBe("POST");
    expect(init.body).toContain("grant_type=refresh_token");
    expect(init.body).toContain("refresh_token=rt");
    const instances = await imapInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0].opts).toEqual({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      logger: false,
      auth: { user: "relayer@gmail.com", accessToken: "access-tok" },
    });
  });

  it("constructs ImapFlow with user/pass when only app password env present", async () => {
    process.env.RELAYER_EMAIL = "relayer@gmail.com";
    process.env.GMAIL_APP_PASSWORD = "app-pass";
    void runInboundFromEnv(deps());
    await new Promise((r) => setImmediate(r));
    expect(fetchMock).not.toHaveBeenCalled();
    const instances = await imapInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0].opts.auth).toEqual({ user: "relayer@gmail.com", pass: "app-pass" });
  });

  it("throws when neither oauth2 nor app password configured", async () => {
    process.env.RELAYER_EMAIL = "relayer@gmail.com";
    await expect(runInboundFromEnv(deps())).rejects.toThrow(/required/);
    expect(await imapInstances()).toHaveLength(0);
  });
});
