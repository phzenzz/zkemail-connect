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
  if (entry.kind === "batch") return `每人 ${amount} ${symbol} · 共 ${entry.count} 人`.trim();
  return `${amount} ${symbol}`.trim();
}

function StatusBadge({ status }: { status: SentStatus }) {
  switch (status.state) {
    case "pending":
      return (
        <Badge variant="secondary" title="资金仍在托管地址，等待对方凭邮箱领取">
          待领取
        </Badge>
      );
    case "claimed":
      return (
        <Badge variant="outline" title="对方已凭邮箱领取，托管账户已关闭">
          已领取
        </Badge>
      );
    case "closed":
      return (
        <Badge variant="outline" title="批次已全部领完或过期退款，托管账户已关闭">
          已关闭
        </Badge>
      );
    case "open":
      if (!status.sealed)
        return (
          <Badge variant="destructive" title="上传中断，批次未密封；重新发送同一收件人列表可断点续传">
            未密封
          </Badge>
        );
      return (
        <Badge variant="secondary" title="领取进度">
          已领取 {status.claimed}/{status.count}
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
          <CardTitle>发送记录</CardTitle>
          <CardDescription>链上解析本地址最近 {SEND_HISTORY_LIMIT} 笔交易，时间倒序。</CardDescription>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="刷新发送记录"
          disabled={loading || !publicKey}
          onClick={() => void refresh()}
        >
          <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!publicKey && <p className="text-muted-foreground">连接钱包后显示发送记录。</p>}

        {publicKey && loading && entries === null && <p className="text-muted-foreground">解析链上交易中…</p>}

        {publicKey && error && (
          <div className="space-y-2">
            <p className="text-destructive">发送记录加载失败：{error}</p>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              重试
            </Button>
          </div>
        )}

        {publicKey && entries !== null && entries.length === 0 && !loading && (
          <p className="text-muted-foreground">暂无发送记录。</p>
        )}

        {entries?.map((entry) => (
          <div key={entry.pda} className="space-y-1 border-b pb-3 last:border-b-0 last:pb-0">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <Badge variant="outline">{entry.kind === "escrow" ? "单发" : "批量"}</Badge>
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
                title={`托管地址：${entry.pda}`}
              >
                {entry.pda.slice(0, 8)}…{entry.pda.slice(-8)}
              </a>
              <span>{entry.createdAt ? new Date(entry.createdAt * 1000).toLocaleString() : "时间未知"}</span>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
