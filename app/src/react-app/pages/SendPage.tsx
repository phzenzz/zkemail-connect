import { useCallback, useEffect, useState } from "react";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { BN } from "@coral-xyz/anchor";
import { useAppConfig, useEmailWalletProgram } from "@/lib/solana";
import { computeCommitment, fieldToBE32, sealEmailForRelayer } from "@/lib/zkCrypto";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type MyEscrow = { addr: PublicKey; mint: PublicKey; amount: bigint; commitment: number[] };

export default function SendPage() {
  const config = useAppConfig();
  const program = useEmailWalletProgram();
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const [email, setEmail] = useState("");
  const [mintIdx, setMintIdx] = useState(0);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ escrow: string; claimUrl: string } | null>(null);
  const [mine, setMine] = useState<MyEscrow[]>([]);

  const refreshMine = useCallback(async () => {
    if (!program || !publicKey || !config) return;
    // 无 DB:全量拉取后按 sender 过滤(devnet 账户数少,MVP 可接受)
    const all = await (program.account as any).escrow.all();
    setMine(
      all
        .filter((e: any) => (e.account.sender as PublicKey).equals(publicKey))
        .map((e: any) => ({
          addr: e.publicKey,
          mint: e.account.mint,
          amount: BigInt(e.account.amount.toString()),
          commitment: Array.from(e.account.commitment),
        }))
    );
  }, [program, publicKey, config]);

  useEffect(() => { refreshMine().catch(console.error); }, [refreshMine]);

  if (!config || !program) return null;
  const mint = config.mints[mintIdx] ?? config.mints[0];

  const submit = async () => {
    if (!publicKey || !mint) return;
    setBusy(true); setError(null); setDone(null);
    try {
      const trimmed = email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) throw new Error("invalid email");
      const commitment = await computeCommitment(trimmed);
      const commitmentBytes = fieldToBE32(commitment);
      const cipher = sealEmailForRelayer(trimmed, config.relayX25519Pk);
      const relayerEmailHash = fieldToBE32(await computeCommitment(config.relayEmail));
      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), Buffer.from(commitmentBytes), publicKey.toBuffer()],
        config.programId
      );
      const [protocolPda] = PublicKey.findProgramAddressSync([Buffer.from("protocol")], config.programId);
      const [relayerEntryPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("relayer"), Buffer.from(relayerEmailHash)],
        config.programId
      );
      const protocol = await (program.account as any).protocolConfig.fetchNullable(protocolPda);
      if (!protocol) throw new Error("protocol not initialized on this cluster");
      const mintPk = new PublicKey(mint.mint);
      const vault = getAssociatedTokenAddressSync(mintPk, escrowPda);
      const senderAta = getAssociatedTokenAddressSync(mintPk, publicKey);
      const decimals = mint.decimals;
      const raw = BigInt(Math.round(parseFloat(amount) * 10 ** decimals));
      if (raw <= 0n) throw new Error("invalid amount");
      const sig = await (program.methods as any)
        .createEscrow(Array.from(commitmentBytes), new BN(raw.toString()), Array.from(cipher), Array.from(relayerEmailHash))
        .accounts({
          escrow: escrowPda,
          vault,
          mint: mintPk,
          senderAta,
          sender: publicKey,
          config: protocolPda,
          treasury: protocol.treasury,
          relayerEntry: relayerEntryPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      const claimUrl = config.claimBaseUrl + escrowPda.toBase58();
      setDone({ escrow: escrowPda.toBase58(), claimUrl });
      await connection.confirmTransaction(sig, "confirmed");
      await refreshMine();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="container mx-auto max-w-xl px-4 py-8 space-y-6">
      <h1 className="text-2xl font-bold">Send tokens to an email</h1>
      <Card>
        <CardHeader>
          <CardTitle>New transfer</CardTitle>
          <CardDescription>
            发送后不可撤回。接收方无需有钱包,凭邮箱回复即可领取。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex justify-end"><WalletMultiButton /></div>
          <div className="space-y-2">
            <Label htmlFor="email">Recipient email</Label>
            <Input id="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="friend@gmail.com" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="mint">Token</Label>
            <select id="mint" className="w-full border rounded p-2 bg-background" value={mintIdx} onChange={(e) => setMintIdx(Number(e.target.value))}>
              {config.mints.map((m, i) => (
                <option key={m.mint} value={i}>{m.symbol} ({m.mint.slice(0, 8)}…)</option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="amount">Amount</Label>
            <Input id="amount" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="10" />
          </div>
          <Button className="w-full" disabled={!publicKey || busy || !mint} onClick={submit}>
            {busy ? "Sending…" : publicKey ? "Send (irreversible)" : "Connect wallet first"}
          </Button>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {done && (
            <div className="text-sm space-y-1 border rounded p-3">
              <p>Escrow: <code className="break-all">{done.escrow}</code></p>
              <p>Claim link: <a className="underline break-all" href={done.claimUrl} target="_blank" rel="noreferrer">{done.claimUrl}</a></p>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>My escrows</CardTitle>
          <CardDescription>状态实时来自链上。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {mine.length === 0 && <p className="text-muted-foreground">none yet</p>}
          {mine.map((e) => (
            <div key={e.addr.toBase58()} className="flex justify-between border-b pb-2">
              <span>{(Number(e.amount) / 10 ** (mint?.decimals ?? 0)).toString()} {mint?.symbol}</span>
              <a className="underline" href={config.claimBaseUrl + e.addr.toBase58()} target="_blank" rel="noreferrer">
                pending → claim page
              </a>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
