import nodemailer, { Transporter } from "nodemailer";

export interface NotifyPayload {
  escrow: string;
  sender: string;
  amount: string;
  claimUrl: string;
}

export interface Notifier {
  notify(to: string, p: NotifyPayload): Promise<void>;
}

/** v1 默认实现：打印通知内容。SMTP 实现替换此类即可（保持接口）。 */
export class ConsoleNotifier implements Notifier {
  async notify(to: string, p: NotifyPayload): Promise<void> {
    console.log(`[notify] to=${to} escrow=${p.escrow} amount=${p.amount} sender=${p.sender} claim=${p.claimUrl}`);
  }
}

/** Gmail 认证方式:应用专用密码 或 OAuth2(XOAUTH2)。 */
export type GmailAuth =
  | { kind: "appPassword"; pass: string }
  | { kind: "oauth2"; clientId: string; clientSecret: string; refreshToken: string };

export interface GmailNotifierOpts {
  user: string;      // 个人 Gmail 地址(= relay 地址)
  auth: GmailAuth;   // 应用专用密码或 OAuth2(二选一)
  fromName?: string; // 展示名,默认 "Token Airdrop"
}

/** 按 env 解析 Gmail 认证,优先级:OAuth2(refresh token + client id/secret)> 应用专用密码;均未配置返回 null。 */
export function gmailAuthFromEnv(env: NodeJS.ProcessEnv): GmailAuth | null {
  const { GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET, GMAIL_OAUTH_REFRESH_TOKEN } = env;
  if (GMAIL_OAUTH_CLIENT_ID && GMAIL_OAUTH_CLIENT_SECRET && GMAIL_OAUTH_REFRESH_TOKEN) {
    return {
      kind: "oauth2",
      clientId: GMAIL_OAUTH_CLIENT_ID,
      clientSecret: GMAIL_OAUTH_CLIENT_SECRET,
      refreshToken: GMAIL_OAUTH_REFRESH_TOKEN,
    };
  }
  if (env.GMAIL_APP_PASSWORD) return { kind: "appPassword", pass: env.GMAIL_APP_PASSWORD };
  return null;
}

/** Gmail SMTP 出站通知。Reply-To 固定为 relay 地址:接收方点"回复"即进入 relayer 收件箱。 */
export class GmailNotifier implements Notifier {
  private tx: Transporter;
  private from: string;
  private relayEmail: string;
  constructor(opts: GmailNotifierOpts) {
    this.tx = nodemailer.createTransport(
      opts.auth.kind === "oauth2"
        ? {
            service: "gmail",
            auth: {
              type: "OAuth2",
              user: opts.user,
              clientId: opts.auth.clientId,
              clientSecret: opts.auth.clientSecret,
              refreshToken: opts.auth.refreshToken,
            },
          }
        : {
            host: "smtp.gmail.com",
            port: 465,
            secure: true,
            auth: { user: opts.user, pass: opts.auth.pass },
          }
    );
    this.from = `${opts.fromName ?? "Token Airdrop"} <${opts.user}>`;
    this.relayEmail = opts.user;
  }

  async notify(to: string, p: NotifyPayload): Promise<void> {
    const subject = `You received ${p.amount} tokens — reply to claim`;
    const text = [
      `Hi,`,
      ``,
      `Someone sent you ${p.amount} tokens on Solana.`,
      ``,
      `To claim it:`,
      `1. Open your claim page: ${p.claimUrl}`,
      `2. Paste your Solana receiving address.`,
      `3. Tap "Send claim email" — your mail app opens with everything pre-filled. Just hit send.`,
      ``,
      `Security: only trust emails from ${p.claimUrl.split("/claim/")[0]}. We never ask for your seed phrase.`,
    ].join("\n");
    await this.tx.sendMail({
      from: this.from,
      to,
      replyTo: this.relayEmail,
      subject,
      text,
      html: `<p>Someone sent you <b>${p.amount}</b> tokens on Solana.</p>
             <p><a href="${p.claimUrl}">Open claim page</a>, paste your Solana address, then tap "Send claim email".</p>
             <p style="color:#888">We never ask for your seed phrase.</p>`,
    });
  }
}
