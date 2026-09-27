import { useCallback, useEffect, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useParams } from "@tanstack/react-router";
import { useAppConfig, useEmailWalletProgram } from "@/lib/solana";
import { DEST_RE } from "@/lib/zkCrypto";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type EscrowState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "open"; amount: bigint; mint: PublicKey }
  | { kind: "claimed" };

export default function ClaimPage() {
  const { escrow } = useParams({ strict: false });
  const config = useAppConfig();
  const program = useEmailWalletProgram();
  const [state, setState] = useState<EscrowState>({ kind: "loading" });
  const [dest, setDest] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    if (!program || !escrow) return;
    try {
      const pk = new PublicKey(escrow);
      const acc = await (program.account as any).escrow.fetchNullable(pk);
      if (!acc) setState({ kind: "claimed" });
      else setState({ kind: "open", amount: BigInt(acc.amount.toString()), mint: acc.mint });
    } catch (e: any) {
      setState({ kind: "missing" });
    }
  }, [program, escrow]);

  useEffect(() => {
    refresh();
    // 领取后轮询:5s 一次,最多 30 次(150s),之后提示手动刷新
    timer.current = setInterval(() => refresh(), 5000);
    const stop = setTimeout(() => { if (timer.current) clearInterval(timer.current); }, 150_000);
    return () => { if (timer.current) clearInterval(timer.current); clearTimeout(stop); };
  }, [refresh]);

  if (!config) return null;
  const mintMeta = config.mints.find((m) => state.kind === "open" && m.mint === state.mint.toBase58());
  const destOk = DEST_RE.test(dest.trim());
  const mailto = `mailto:${config.relayEmail}?subject=${encodeURIComponent(dest.trim())}`;

  return (
    <div className="container mx-auto max-w-xl px-4 py-8 space-y-6">
      <h1 className="text-2xl font-bold">Claim your tokens</h1>
      {state.kind === "loading" && <p>loading…</p>}
      {state.kind === "missing" && <p className="text-destructive">invalid escrow address</p>}
      {state.kind === "claimed" && (
        <Card><CardContent className="pt-6">✅ This transfer has been claimed (escrow closed on-chain).</CardContent></Card>
      )}
      {state.kind === "open" && (
        <Card>
          <CardHeader>
            <CardTitle>
              You received {mintMeta ? (Number(state.amount) / 10 ** mintMeta.decimals).toString() : state.amount.toString()} {mintMeta?.symbol ?? ""}
            </CardTitle>
            <CardDescription>Reply by email to claim — no wallet needed for the reply, only a receiving address.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="dest">Your Solana receiving address</Label>
              <Input id="dest" value={dest} onChange={(e) => { setDest(e.target.value); setConfirmed(false); }} placeholder="base58 address" />
              {!destOk && dest.length > 0 && <p className="text-sm text-destructive">invalid base58 address (32–44 chars)</p>}
            </div>
            {destOk && !confirmed && (
              <div className="border rounded p-3 text-sm space-y-2">
                <p>Confirm receiving address:</p>
                <p className="break-all"><code>{dest.trim()}</code></p>
                <Button size="sm" onClick={() => setConfirmed(true)}>Confirm</Button>
              </div>
            )}
            {destOk && confirmed && (
              <div className="space-y-2">
                <Button className="w-full" asChild>
                  <a href={mailto}>Send claim email</a>
                </Button>
                <p className="text-sm text-muted-foreground">
                  Your mail app opens with recipient and subject (= your address) pre-filled.
                  Body can stay empty — just hit send. This page will update once the relayer processes your reply.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
