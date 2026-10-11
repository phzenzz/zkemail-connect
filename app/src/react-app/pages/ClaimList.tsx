import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { PublicKey } from "@solana/web3.js";
import { useAppConfig, useEmailWalletProgram } from "@/lib/solana";
import { computeCommitment, fieldToBE32 } from "@/lib/zkCrypto";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Claimable = { escrow: string; mint: string; amount: bigint };

type State =
  | { kind: "loading" }
  | { kind: "ready"; rows: Claimable[] }
  | { kind: "error"; message: string };

/** 链上 [u8;32] 反序列化类型不稳定（number[] | Uint8Array），故按 ArrayLike 比。 */
function bytesEqual(a: ArrayLike<number>, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 后台 Claim Tab：按当前登录邮箱列出可领取的托管。
 *
 * 查询方式说明：escrow PDA 的种子是 ["escrow", commitment, sender]，sender 也在种子里，
 * 所以无法只凭邮箱反推地址，只能全量拉取后按 commitment(= Poseidon(收件人邮箱)) 过滤。
 * devnet 账户数少，MVP 可接受（与 SendPage 的「My escrows」同策略）。
 */
export default function ClaimList() {
  const config = useAppConfig();
  const program = useEmailWalletProgram();
  const auth = useAuth();
  const email = auth.status === "authed" ? auth.user.email : null;
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    if (!program || !config || !email) return;
    let cancelled = false;
    (async () => {
      try {
        const mine = fieldToBE32(await computeCommitment(email));
        const all = await (program.account as any).escrow.all();
        const rows: Claimable[] = all
          .filter((e: any) => bytesEqual(e.account.commitment, mine))
          .map((e: any) => ({
            escrow: e.publicKey.toBase58(),
            mint: (e.account.mint as PublicKey).toBase58(),
            amount: BigInt(e.account.amount.toString()),
          }));
        if (!cancelled) setState({ kind: "ready", rows });
      } catch (e: any) {
        if (!cancelled) setState({ kind: "error", message: e?.message ?? String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [program, config, email]);

  return (
    <div className="container mx-auto max-w-xl space-y-6 px-4 py-8">
      <h1 className="text-2xl font-bold">Claim tokens</h1>

      <Card>
        <CardHeader>
          <CardTitle>Transfers for you</CardTitle>
          <CardDescription>
            Escrows addressed to <span className="font-medium text-foreground">{email ?? "…"}</span>. Pick one to
            claim it by email.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {state.kind === "loading" && <p className="text-muted-foreground">Loading…</p>}

          {state.kind === "error" && (
            <p className="text-destructive">Could not load transfers: {state.message}</p>
          )}

          {state.kind === "ready" && state.rows.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <div className="h-24 w-24 rounded-lg bg-muted" />
              <p className="text-muted-foreground">
                No claimable transfers for this address yet. The sender needs to use this exact email.
              </p>
            </div>
          )}

          {state.kind === "ready" &&
            state.rows.map((row) => {
              const meta = config?.mints.find((m) => m.mint === row.mint);
              const display = meta
                ? `${Number(row.amount) / 10 ** meta.decimals} ${meta.symbol}`
                : row.amount.toString();
              return (
                <div
                  key={row.escrow}
                  className="flex items-center justify-between gap-4 border-b pb-3 last:border-b-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className="font-medium">{display}</p>
                    <p className="truncate font-mono text-xs text-muted-foreground" title={row.escrow}>
                      {row.escrow.slice(0, 8)}…{row.escrow.slice(-8)}
                    </p>
                  </div>
                  <Button asChild size="sm">
                    <Link to="/app/claim/$escrow" params={{ escrow: row.escrow }}>
                      Claim
                    </Link>
                  </Button>
                </div>
              );
            })}
        </CardContent>
      </Card>
    </div>
  );
}
