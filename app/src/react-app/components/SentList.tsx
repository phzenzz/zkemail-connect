import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { RefreshCw } from "lucide-react";
import { useAppConfig, useEmailWalletProgram, type AppConfig } from "@/lib/solana";
import { fetchSentHistory, SEND_HISTORY_LIMIT, type SentEntry, type SentStatus } from "@/lib/sendHistory";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function amountText(entry: SentEntry, config: AppConfig): string {
  const meta = config.mints.find((m) => m.mint === entry.mint);
  const symbol = meta?.symbol ?? (entry.mint ? `${entry.mint.slice(0, 4)}…${entry.mint.slice(-4)}` : "");
  const amount = Number(entry.amountPer) / 10 ** (meta?.decimals ?? 0);
  if (entry.kind === "batch") return `${amount} ${symbol} each · ${entry.count} recipients`.trim();
  return `${amount} ${symbol}`.trim();
}

function StatusBadge({ status }: { status: SentStatus }) {
  switch (status.state) {
    case "pending":
      return (
        <Badge variant="secondary" title="Funds remain in the escrow address, waiting for the recipient to claim via email">
          Pending
        </Badge>
      );
    case "claimed":
      return (
        <Badge variant="outline" title="The recipient claimed via email; the escrow account is closed">
          Claimed
        </Badge>
      );
    case "closed":
      return (
        <Badge variant="outline" title="Batch fully claimed or refunded after expiry; the escrow account is closed">
          Closed
        </Badge>
      );
    case "open":
      if (!status.sealed)
        return (
          <Badge variant="destructive" title="Upload interrupted before the batch was sealed — resend the same recipient list to resume">
            Unsealed
          </Badge>
        );
      return (
        <Badge variant="secondary" title="Claim progress">
          {status.claimed}/{status.count} claimed
        </Badge>
      );
  }
}

/** Send 页右栏：本地址的已发送记录（链上解析，时间倒序）。 */
export default function SentList({ refreshNonce = 0 }: { refreshNonce?: number }) {
  const config = useAppConfig();
  const program = useEmailWalletProgram();
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const [entries, setEntries] = useState<SentEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!publicKey || !config || !program) return;
    setLoading(true);
    setError(null);
    try {
      const rows = await fetchSentHistory(connection, program, config.programId, publicKey);
      setEntries(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [connection, publicKey, config, program]);

  useEffect(() => {
    setEntries(null);
    void refresh();
  }, [refresh, refreshNonce]);

  if (!config) return null;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>Sent history</CardTitle>
          <CardDescription>Parsed on-chain from this address's latest {SEND_HISTORY_LIMIT} transactions, newest first.</CardDescription>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh sent history"
          disabled={loading || !publicKey}
          onClick={() => void refresh()}
        >
          <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!publicKey && <p className="text-muted-foreground">Connect a wallet to see your sent history.</p>}

        {publicKey && loading && entries === null && <p className="text-muted-foreground">Parsing on-chain transactions…</p>}

        {publicKey && error && (
          <div className="space-y-2">
            <p className="text-destructive">Failed to load sent history: {error}</p>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              Retry
            </Button>
          </div>
        )}

        {publicKey && entries !== null && entries.length === 0 && !loading && (
          <p className="text-muted-foreground">No sent history yet.</p>
        )}

        {entries?.map((entry) => (
          <div key={entry.pda} className="space-y-1 border-b pb-3 last:border-b-0 last:pb-0">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <Badge variant="outline">{entry.kind === "escrow" ? "Single" : "Batch"}</Badge>
                <span className="truncate">{amountText(entry, config)}</span>
              </div>
              <StatusBadge status={entry.status} />
            </div>
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <a
                className="font-mono underline"
                href={`${config.claimBaseUrl}${entry.pda}`}
                target="_blank"
                rel="noreferrer"
                title={`Escrow address: ${entry.pda}`}
              >
                {entry.pda.slice(0, 8)}…{entry.pda.slice(-8)}
              </a>
              <span>{entry.createdAt ? new Date(entry.createdAt * 1000).toLocaleString() : "Time unknown"}</span>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
