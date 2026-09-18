# 测试邮件（.eml）导出指引

本目录存放从真实邮箱导出的原始 `.eml` 文件，供 `scripts/load-email.ts`（真实 DNS DKIM 验签）及后续电路/e2e 测试使用。

**这些 .eml 不入库**（体积大且含个人信息），命名约定如下，按用途各导出一份：

| 文件名 | 用途 | 说明 |
|---|---|---|
| `claim.eml` | claim 测试 | To = 配置的 relay 地址（见下） |
| `sweep.eml` | Inbox 清扫测试 | 同上 |
| `e2e.eml` | 端到端测试 | 同上 |

三封可以在同一次发送操作中完成（发三封邮件即可）。

## Relay 地址（收件人填什么）

收件人 = **当前配置的 relay 地址**，从 `circuits/relay.config.json` 的 `relayAddress` 读取（环境变量 `RELAY_ADDRESS` 可覆盖；`circuits/scripts/relay-config.ts` 是唯一读取入口，loader / 电路正则 / e2e 指引全部以它为准）。

- **生产默认**：`claim@relay.xyz`（专用 relay 域名邮箱，见 PRD）。
- **当前测试值**：`relay.config.json` 里登记的真实 Gmail（维护者自己的邮箱）。用 Gmail 作 relay 地址时，**可以直接发邮件 To 自己**——从自己邮箱发出、收件人也填自己，邮件会进自己的收件箱，**不再需要 Bcc**；导出原件更方便。
- 该地址被**编译进电路 DFA**（ToPresenceRegex）：换地址必须重跑 `bash circuits/scripts/rebuild.sh` 全链（gen-regexes → compile → setup → vk）。

## 一次性导出步骤（Gmail 示例）

用真实邮箱（Gmail 即可）**发送**一封新邮件（不要回复，避免 `Re:` 前缀）：

1. **收件人**：当前配置的 relay 地址（见上一节；电路 DFA 大小写敏感，逐字符与配置一致——全小写就全小写填）。
   生产值 `claim@relay.xyz` 不需要真实存在——Gmail 出站服务器照常 DKIM 签名；测试值是自己的 Gmail，直接真实投递。
2. **标题**：一个合法 Solana base58 地址（如 `4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM`），**整行只有地址，不加任何多余字符**。
3. **正文**：任意（可为空）。

然后在 Gmail 中打开该邮件 → 右上角「更多」→「显示原始邮件」→ 下载为 `.eml`，按上表命名放入本目录。

## 注意事项（踩坑记录）

- **48 小时时效**：链上时间窗 `TIMESTAMP_WINDOW_PAST` 为 48h。`.eml` 里的 DKIM `t=` 超过 48h 后，`loadClaimEmail` 会明确报错提示重新导出；e2e 同理。请在临近运行测试时再导出。
- **DKIM `h=` 头列表**：Gmail 签名必含 `from:to:subject:date`，满足电路要求。
- **域对齐**：`d=gmail.com` 与 From 域天然对齐；loader 会断言二者一致（不符即抛错）。
- **`t=` 标签**：Gmail 的 DKIM-Signature 含 `t=`，loader 解析它作为 `timestamp`。若换其他服务商导致解析/对齐失败，loader 会给出具体原因的报错——请把报错记入 spec §12 兼容性清单。
- **To 必须逐字符匹配配置地址**（大小写敏感）：`To:Claim@...` 或 plus-address（`claim+xxx@...`）都会在 loader 阶段即以明确报错拒绝（与电路 DFA 同一语义）。
- 导出的 `.eml` 需保持**原始 CRLF 与全部头部字节**，不要经过任何邮件客户端转存（会破坏 DKIM 验签）。

## 验证

```bash
cd circuits && npx tsx -e "
import('./scripts/load-email.ts').then(async (m) => {
  const r = await m.loadClaimEmail('testdata/emails/claim.eml', 123n);
  console.log('OK', { from: r.meta.fromEmail, selector: r.meta.selector,
    dest: r.meta.destBase58, ts: r.meta.timestamp });
});"
```

DKIM 验签走真实 DNS（DoH，需外网），不拦截任何网络请求。
