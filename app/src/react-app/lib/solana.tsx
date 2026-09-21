import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { PublicKey } from "@solana/web3.js";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { ConnectionProvider, WalletProvider, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import idl from "./idl/email_wallet.json";

// anchor 依赖 Buffer(浏览器无内置)
import { Buffer } from "buffer";
if (!(globalThis as any).Buffer) (globalThis as any).Buffer = Buffer;

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

export function SolanaProviders({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    []
  );
  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((j) =>
        setConfig({
          programId: new PublicKey(j.programId),
          rpcUrl: j.rpcUrl,
          relayEmail: j.relayEmail,
          relayX25519Pk: new Uint8Array(j.relayX25519Pk.match(/.{2}/g).map((h: string) => parseInt(h, 16))),
          claimBaseUrl: j.claimBaseUrl,
          mints: j.mints ?? [],
        })
      )
      .catch((e) => console.error("config fetch failed", e));
  }, []);
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
  const wallet = useWallet();
  return useMemo(() => {
    if (!config) return null;
    const signer = wallet.wallet?.adapter ?? ({} as never);
    const provider = new AnchorProvider(connection, signer as any, { commitment: "confirmed" });
    return new Program(idl as any, provider);
  }, [config, connection, wallet.wallet]);
}
