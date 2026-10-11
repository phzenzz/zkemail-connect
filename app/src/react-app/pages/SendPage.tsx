import { useCallback, useEffect, useState } from "react";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { AccountLayout, MintLayout, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton, useWalletModal } from "@solana/wallet-adapter-react-ui";
import { BN } from "@coral-xyz/anchor";
import { useAppConfig, useEmailWalletProgram, pollSignatureConfirmation } from "@/lib/solana";
import { computeCommitment, fieldToBE32, sealEmailForRelayer, sealBytes } from "@/lib/zkCrypto";
import { buildBatchTree } from "@/lib/merkle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import SentList from "@/components/SentList";

type TokenOption = { mint: string; symbol: string; decimals: number; balance?: bigint };

function formatTokenAmount(raw: bigint, decimals: number): string {
  return (Number(raw) / 10 ** decimals).toLocaleString(undefined, { maximumFractionDigits: decimals });
}

export default function SendPage() {
  const config = useAppConfig();
  const program = useEmailWalletProgram();
  const { publicKey, signTransaction } = useWallet();
  const { setVisible: setWalletModalVisible } = useWalletModal();
  const { connection } = useConnection();
  const [email, setEmail] = useState("");
  const [mintChoice, setMintChoice] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ escrow: string; claimUrl: string } | null>(null);
  const [sentNonce, setSentNonce] = useState(0);
  const [walletTokens, setWalletTokens] = useState<TokenOption[] | null>(null);
  const [tokensError, setTokensError] = useState<string | null>(null);
  type Mode = "single" | "batch";
  const [mode, setMode] = useState<Mode>("single");
  const [recipients, setRecipients] = useState<string[]>(["", "", ""]);
  const [pasteText, setPasteText] = useState("");
  const [expiryDays, setExpiryDays] = useState("7");
  const [progress, setProgress] = useState<{ step: string; done: number; total: number } | null>(null);
  const [doneBatch, setDoneBatch] = useState<{ batch: string; count: number; claimUrl: string } | null>(null);

  // 连上钱包后拉取钱包实际持有的 SPL 代币；断开时清空回退到静态配置。
  // 优先走 Worker 代理 /api/wallet-tokens（Helius API key 只存后端，且公共 RPC 常禁用
  // getTokenAccountsByOwner）；后端未配 key（本地 validator 场景）时直连当前 RPC。
  const withTimeout = useCallback(<T,>(p: Promise<T>, ms: number, what: string) =>
    Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what}超时`)), ms))]), []);

  const refreshTokens = useCallback(async () => {
    if (!publicKey || !config) {
      setWalletTokens(null);
      setTokensError(null);
      return;
    }
    try {
      const decimalsByMint = new Map<string, number>();
      const held: { mint: PublicKey; amount: bigint }[] = [];

      const proxyRes = await withTimeout(fetch(`/api/wallet-tokens/${publicKey.toBase58()}`), 15_000, "代币查询");
      if (proxyRes.ok) {
        const j = await proxyRes.json();
        for (const t of j.tokens ?? []) {
          decimalsByMint.set(t.mint, t.decimals);
          held.push({ mint: new PublicKey(t.mint), amount: BigInt(t.amount) });
        }
      } else if (proxyRes.status === 503) {
        // 后端无 Helius key：直连 RPC（base64 + 本地解码，兼容性最好）
        const resp = await withTimeout(
          connection.getTokenAccountsByOwner(publicKey, { programId: TOKEN_PROGRAM_ID }),
          15_000,
          "代币查询",
        );
        const direct = resp.value
          .map((v) => {
            const { mint, amount } = AccountLayout.decode(v.account.data);
            return { mint, amount };
          })
          .filter((t) => t.amount > 0n);
        const mintInfos = await connection.getMultipleAccountsInfo(direct.map((t) => t.mint));
        direct.forEach((t, i) => {
          if (mintInfos[i]) decimalsByMint.set(t.mint.toBase58(), MintLayout.decode(mintInfos[i].data).decimals);
        });
        held.push(...direct);
      } else {
        const j = await proxyRes.json().catch(() => null);
        throw new Error(j?.error ?? `wallet-tokens HTTP ${proxyRes.status}`);
      }

      const tokens: TokenOption[] = held
        .filter((t) => decimalsByMint.has(t.mint.toBase58()))
        .map((t) => {
          const mint = t.mint.toBase58();
          const cfg = config.mints.find((m) => m.mint === mint);
          return {
            mint,
            symbol: cfg?.symbol ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`,
            decimals: decimalsByMint.get(mint)!,
            balance: t.amount,
          };
        });
      // 配置内（可发托管）的代币排前面，其余按余额降序
      tokens.sort((a, b) => {
        const ai = config.mints.findIndex((m) => m.mint === a.mint);
        const bi = config.mints.findIndex((m) => m.mint === b.mint);
        if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
        return Number(b.balance! - a.balance!);
      });
      setWalletTokens(tokens);
      setTokensError(null);
    } catch (e: any) {
      console.error("refreshTokens failed", e);
      setTokensError(e?.message ?? String(e));
    }
  }, [publicKey, connection, config, withTimeout]);

  useEffect(() => { refreshTokens().catch(console.error); }, [refreshTokens]);

  if (!config || !program) return null;
  // 已连接钱包：展示钱包实际持有的代币；未连接：回退到静态配置列表
  const tokenOptions: TokenOption[] = walletTokens ?? config.mints;
  const mint = tokenOptions.find((t) => t.mint === mintChoice) ?? tokenOptions[0];

  const submit = async () => {
    if (!mint) {
      setError("no mint configured");
      return;
    }
    if (!publicKey) {
      setWalletModalVisible(true);
      return;
    }
    setBusy(true); setError(null); setDone(null);
    try {
      const trimmed = email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) throw new Error("invalid email");
      const amountNum = parseFloat(amount);
      if (!Number.isFinite(amountNum) || amountNum <= 0) throw new Error("invalid amount");
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
      // escrow PDA 在曲线外，vault ATA 必须 allowOwnerOffCurve
      const vault = getAssociatedTokenAddressSync(mintPk, escrowPda, true);
      const senderAta = getAssociatedTokenAddressSync(mintPk, publicKey);
      const decimals = mint.decimals;
      const raw = BigInt(Math.round(amountNum * 10 ** decimals));
      if (raw <= 0n) throw new Error("invalid amount");
      const tx = await (program.methods as any)
        .createEscrow(
          Array.from(commitmentBytes),
          new BN(raw.toString()),
          // Anchor `bytes` 在浏览器里必须是 Buffer；Array.from 会触发 Blob.encode 报错
          Buffer.from(cipher),
          Array.from(relayerEmailHash),
        )
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
        .transaction();
      // 不用 .rpc()：其内部 confirmTransaction 依赖 ws 订阅，RPC 走 HTTP 代理时会挂死。
      // 手动签名 + 发送 + 轮询确认（pollSignatureConfirmation）。
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      if (!signTransaction) throw new Error("wallet does not support transaction signing");
      const signed = await signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize());
      await pollSignatureConfirmation(connection, sig);
      const claimUrl = config.claimBaseUrl + escrowPda.toBase58();
      setDone({ escrow: escrowPda.toBase58(), claimUrl });
      await refreshTokens();
      setSentNonce((n) => n + 1);
    } catch (e: any) {
      const msg =
        e?.message ||
        e?.error?.errorMessage ||
        e?.name ||
        (typeof e === "string" ? e : null) ||
        String(e);
      setError(msg);
      console.error("createEscrow failed", e);
    } finally {
      setBusy(false);
    }
  };

  const submitBatch = async () => {
    if (!mint) { setError("no mint configured"); return; }
    if (!publicKey) { setWalletModalVisible(true); return; }
    setBusy(true); setError(null); setDone(null); setDoneBatch(null); setProgress(null);
    try {
      const emails = Array.from(new Set(
        recipients.map((r) => r.trim().toLowerCase()).filter((r) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r))
      ));
      if (emails.length === 0) throw new Error("no valid recipient emails");
      const amountNum = parseFloat(amount);
      if (!Number.isFinite(amountNum) || amountNum <= 0) throw new Error("invalid per-recipient amount");
      const days = parseInt(expiryDays, 10);
      if (!Number.isFinite(days) || days < 1) throw new Error("invalid expiry days");

      const commitmentBytesList = [];
      for (const e of emails) commitmentBytesList.push(fieldToBE32(await computeCommitment(e)));
      const tree = await buildBatchTree(commitmentBytesList);
      const cipher = sealBytes(new TextEncoder().encode(JSON.stringify(emails)), config.relayX25519Pk);
      if (cipher.length > 64_000) throw new Error("recipient list too large (>64KB)");

      const relayerEmailHash = fieldToBE32(await computeCommitment(config.relayEmail));
      const mintPk = new PublicKey(mint.mint);
      const raw = BigInt(Math.round(amountNum * 10 ** mint.decimals));
      if (raw <= 0n) throw new Error("invalid amount");
      const expireAt = Math.floor(Date.now() / 1000) + days * 86_400;

      const [protocolPda] = PublicKey.findProgramAddressSync([Buffer.from("protocol")], config.programId);
      const [relayerEntryPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("relayer"), Buffer.from(relayerEmailHash)], config.programId);
      const protocol = await (program.account as any).protocolConfig.fetchNullable(protocolPda);
      if (!protocol) throw new Error("protocol not initialized on this cluster");
      const senderAta = getAssociatedTokenAddressSync(mintPk, publicKey);

      const sendTx = async (tx: any, label: string, idx: number, total: number) => {
        setProgress({ step: label, done: idx, total });
        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.feePayer = publicKey;
        if (!signTransaction) throw new Error("wallet does not support transaction signing");
        const signed = await signTransaction(tx);
        const sig = await connection.sendRawTransaction(signed.serialize());
        await pollSignatureConfirmation(connection, sig);
      };

      // issue #9：批次 PDA = ["batch", sender, merkle_root, nonce]，nonce 随机 → 同一收件人列表
      // 可重复发送。localStorage 草稿记录已上链 createBatch 的 nonce：append/seal 中断后复用
      // 同一 nonce 续传收尾，避免留下未 seal 的孤儿批次锁资金；sealed 的草稿说明是同笔误重试，
      // 丢弃后换新 nonce 重新发一批。地址被占仅可能是自己的草稿（碰撞 ~1/2^64），重试即解。
      const rootBuf = Buffer.from(tree.root);
      const nonceSeed = (n: BN) => n.toArrayLike(Buffer, "le", 8); // 与 Rust nonce.to_le_bytes() 一致
      const randomNonce = () => {
        const b = new Uint8Array(8);
        globalThis.crypto.getRandomValues(b);
        return new BN(Buffer.from(b).toString("hex"), 16);
      };
      const draftKey = `batch-draft:${publicKey.toBase58()}:${rootBuf.toString("hex")}`;
      const draft = window.localStorage.getItem(draftKey);

      let nonce: BN | null = null;
      let batchPda: PublicKey | null = null;
      let existing: any = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const candidate = attempt === 0 && draft ? new BN(draft) : randomNonce();
        const candidatePda = PublicKey.findProgramAddressSync(
          [Buffer.from("batch"), publicKey.toBuffer(), rootBuf, nonceSeed(candidate)], config.programId)[0];
        const acc = await (program.account as any).batch.fetchNullable(candidatePda);
        if (!acc || !acc.sealed) {
          nonce = candidate; batchPda = candidatePda; existing = acc;
          break;
        }
        if (attempt === 0 && draft) window.localStorage.removeItem(draftKey); // sealed：同笔误重试，换新发一批
      }
      if (!nonce || !batchPda) throw new Error("批次地址反复被占用，请重试");

      const vault = getAssociatedTokenAddressSync(mintPk, batchPda, true);

      const uploaded = (existing?.recipientsCipher as Uint8Array | undefined)?.length ?? 0;
      if (existing && uploaded > cipher.length) throw new Error("链上批次密文长度异常，批次状态与本次发送不匹配");

      const needCreate = !existing;
      const tail = cipher.subarray(uploaded);
      const totalChunks = Math.ceil(tail.length / 800);
      const totalTx = (needCreate ? 1 : 0) + totalChunks + 1;
      let idx = 0;

      if (needCreate) {
        const createTx = await (program.methods as any)
          .createBatch(
            Array.from(tree.root), new BN(raw.toString()), emails.length, cipher.length,
            new BN(expireAt), Array.from(relayerEmailHash), nonce,
          )
          .accounts({
            batch: batchPda, vault, mint: mintPk, senderAta, sender: publicKey,
            config: protocolPda, treasury: protocol.treasury, relayerEntry: relayerEntryPda,
            tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .transaction();
        await sendTx(createTx, "create batch", ++idx, totalTx);
        // createBatch 已上链：记下 nonce，后续 append/seal 中断可凭草稿续传
        window.localStorage.setItem(draftKey, nonce.toString());
      }

      for (let i = 0; i < totalChunks; i++) {
        const chunk = Buffer.from(tail.subarray(i * 800, (i + 1) * 800));
        const appendTx = await (program.methods as any)
          .appendBatchCipher(chunk)
          .accounts({ batch: batchPda, sender: publicKey })
          .transaction();
        await sendTx(appendTx, `upload list ${i + 1}/${totalChunks}`, ++idx, totalTx);
      }

      const sealTx = await (program.methods as any)
        .sealBatch()
        .accounts({ batch: batchPda, sender: publicKey })
        .transaction();
      await sendTx(sealTx, "seal", totalTx, totalTx);
      window.localStorage.removeItem(draftKey); // 批次已完成，草稿无保留意义

      setDoneBatch({
        batch: batchPda.toBase58(),
        count: emails.length,
        claimUrl: config.claimBaseUrl + batchPda.toBase58(),
      });
      setProgress(null);
      await refreshTokens();
      setSentNonce((n) => n + 1);
    } catch (e: any) {
      const msg = e?.message || e?.error?.errorMessage || e?.name || String(e);
      setError(msg);
      console.error("batch create failed", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-bold">Send tokens to an email</h1>
      <div className="mt-6 grid items-start gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>New transfer</CardTitle>
          <CardDescription>
            发送后不可撤回。接收方无需有钱包,凭邮箱回复即可领取。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex justify-end"><WalletMultiButton /></div>
          <div className="flex gap-2 border-b pb-3">
            {(["single", "batch"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`px-3 py-1 rounded text-sm ${mode === m ? "bg-primary text-primary-foreground" : "bg-muted"}`}
              >
                {m === "single" ? "单发" : "批量空投"}
              </button>
            ))}
          </div>
          {mode === "batch" ? (
            <div className="space-y-2">
              <Label>Recipients（{recipients.filter((r) => r.trim()).length}）</Label>
              {recipients.map((r, i) => (
                <div key={i} className="flex gap-2">
                  <Input
                    value={r}
                    placeholder={`recipient${i + 1}@example.com`}
                    onChange={(e) => setRecipients(recipients.map((x, j) => (j === i ? e.target.value : x)))}
                  />
                  <Button type="button" variant="outline" onClick={() => setRecipients(recipients.filter((_, j) => j !== i))}>−</Button>
                </div>
              ))}
              <Button type="button" variant="outline" onClick={() => setRecipients([...recipients, ""])}>+ 添加一行</Button>
              <textarea
                className="w-full border rounded p-2 bg-background text-sm"
                rows={3}
                placeholder="或粘贴邮箱列表（逗号/空格/换行分隔），粘贴即填充"
                value={pasteText}
                onChange={(e) => {
                  setPasteText(e.target.value);
                  const emails = e.target.value.split(/[\s,;]+/).filter((x) => x.trim());
                  if (emails.length > 0) setRecipients(emails);
                }}
              />
              <div className="space-y-2">
                <Label>Expiry（days，过期后未领取部分可退款）</Label>
                <Input value={expiryDays} onChange={(e) => setExpiryDays(e.target.value)} placeholder="7" />
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="email">Recipient email</Label>
              <Input id="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="friend@gmail.com" />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="mint">Token</Label>
            <select
              id="mint"
              className="w-full border rounded p-2 bg-background"
              value={mint?.mint ?? ""}
              onChange={(e) => setMintChoice(e.target.value)}
            >
              {tokenOptions.length === 0 && (
                <option value="" disabled>
                  {!publicKey ? "无可用代币" : tokensError ? "代币加载失败" : "此钱包暂无代币"}
                </option>
              )}
              {tokenOptions.map((t) => (
                <option key={t.mint} value={t.mint}>
                  {t.symbol}
                  {t.balance !== undefined && ` · 余额 ${formatTokenAmount(t.balance, t.decimals)}`}
                  {" "}({t.mint.slice(0, 8)}…)
                </option>
              ))}
            </select>
            {publicKey && tokensError && (
              <p className="text-xs text-destructive">
                代币加载失败：{tokensError}（未配 HELIUS_API_KEY 时当前 RPC 可能禁用了代币查询，请在 app/.dev.vars 配置后重启）
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="amount">Amount</Label>
            <Input id="amount" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="10" />
            {mint?.balance !== undefined && (
              <p className="text-xs text-muted-foreground">
                钱包余额: {formatTokenAmount(mint.balance, mint.decimals)} {mint.symbol}
              </p>
            )}
          </div>
          <Button className="w-full" disabled={busy || !mint}
            onClick={() => void (mode === "batch" ? submitBatch() : submit())}>
            {busy
              ? progress
                ? `${progress.step} (${progress.done}/${progress.total})…`
                : "Sending…"
              : publicKey
                ? mode === "batch"
                  ? `Airdrop to ${recipients.filter((r) => r.trim()).length} recipient(s) (irreversible)`
                  : "Send (irreversible)"
                : "Connect wallet to send"}
          </Button>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {doneBatch && (
            <div className="text-sm space-y-1 border rounded p-3">
              <p>Batch: <code className="break-all">{doneBatch.batch}</code></p>
              <p>Recipients: {doneBatch.count}（每人 {amount} {mint?.symbol}）</p>
              <p>Claim link: <a className="underline break-all" href={doneBatch.claimUrl} target="_blank" rel="noreferrer">{doneBatch.claimUrl}</a></p>
            </div>
          )}
          {done && (
            <div className="text-sm space-y-1 border rounded p-3">
              <p>Escrow: <code className="break-all">{done.escrow}</code></p>
              <p>Claim link: <a className="underline break-all" href={done.claimUrl} target="_blank" rel="noreferrer">{done.claimUrl}</a></p>
            </div>
          )}
        </CardContent>
      </Card>
      <SentList refreshNonce={sentNonce} />
      </div>
    </div>
  );
}
