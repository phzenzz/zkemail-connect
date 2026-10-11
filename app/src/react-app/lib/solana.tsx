import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { PublicKey, type Connection } from "@solana/web3.js";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { ConnectionProvider, WalletProvider, useConnection, useAnchorWallet } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import idl from "./idl/email_wallet.json";

export type AppConfig = {
  programId: PublicKey;
  rpcUrl: string;
  relayEmail: string;
  relayX25519Pk: Uint8Array;
  claimBaseUrl: string;
  mints: { mint: string; symbol: string; decimals: number }[];
};

const AppConfigContext = createContext<AppConfig | null>(null);
export const useAppConfig = () => useContext(AppConfigContext);

const REQUIRED_CONFIG_FIELDS = ["programId", "rpcUrl", "relayEmail", "relayX25519Pk", "claimBaseUrl"] as const;

export function SolanaProviders({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    []
  );
  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((j) => {
        // 先显式校验：若让 PublicKey(undefined) 自己抛，异常会被下面的 catch 吞掉，
        // 表现为永久 "loading config…"，看不出真正原因。
        const missing = REQUIRED_CONFIG_FIELDS.filter((k) => !j[k]);
        if (missing.length > 0) {
          throw new Error(`/api/config 缺少 ${missing.join(", ")} —— 检查 Worker 的 vars / app/.dev.vars`);
        }
        setConfig({
          programId: new PublicKey(j.programId),
          rpcUrl: j.rpcUrl,
          relayEmail: j.relayEmail,
          relayX25519Pk: new Uint8Array(j.relayX25519Pk.match(/.{2}/g).map((h: string) => parseInt(h, 16))),
          claimBaseUrl: j.claimBaseUrl,
          mints: j.mints ?? [],
        });
      })
      .catch((e) => {
        console.error("config fetch failed", e);
        setError(e?.message ?? String(e));
      });
  }, []);
  if (error) {
    return (
      <div className="container mx-auto max-w-xl px-4 py-8">
        <p className="text-sm text-destructive">Failed to load app config: {error}</p>
      </div>
    );
  }
  if (!config) return <div className="p-8 text-center text-muted-foreground">loading config…</div>;
  return (
    <AppConfigContext.Provider value={config}>
      <ConnectionProvider endpoint={config.rpcUrl}>
        <WalletProvider wallets={wallets} autoConnect>
          <WalletModalProvider>{children}</WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </AppConfigContext.Provider>
  );
}

/** 只读 Program(claim 页未连钱包也可用)与签名 Program(连钱包后)统一入口。 */
export function useEmailWalletProgram(): Program | null {
  const config = useAppConfig();
  const { connection } = useConnection();
  const anchorWallet = useAnchorWallet();
  return useMemo(() => {
    if (!config) return null;
    // 未连钱包时用只读占位；连上后用 useAnchorWallet 才能正确签名交易
    const signer = anchorWallet ?? ({ publicKey: null } as never);
    const provider = new AnchorProvider(connection, signer as any, { commitment: "confirmed" });
    return new Program(idl as any, provider);
  }, [config, connection, anchorWallet]);
}

/**
 * 确认交易：getSignatureStatuses 轮询。
 * RPC 走 Worker HTTP 代理（/api/rpc）时没有 ws 订阅可用，web3.js 的
 * confirmTransaction 会挂在 ws 上不动，因此统一改用轮询（本地直连场景同样适用）。
 */
export async function pollSignatureConfirmation(
  connection: Connection,
  signature: string,
  commitment: "confirmed" | "finalized" = "confirmed",
  timeoutMs = 90_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status) {
      if (status.err) throw new Error(`交易链上执行失败: ${JSON.stringify(status.err)}`);
      const confirmationStatus = (status as { confirmationStatus?: string }).confirmationStatus;
      if (confirmationStatus === commitment || confirmationStatus === "finalized") return;
    }
    if (Date.now() - start > timeoutMs) throw new Error("交易确认超时");
    await new Promise((r) => setTimeout(r, 2_000));
  }
}
