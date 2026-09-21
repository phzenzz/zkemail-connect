// 一次性 Gmail OAuth2 授权脚本:用 GMAIL_OAUTH_CLIENT_ID/SECRET 换 GMAIL_OAUTH_REFRESH_TOKEN。
// 前置条件(Google Cloud Console):
//   1. 项目已启用 Gmail API;
//   2. OAuth 同意屏幕类型 External,scope 添加 https://mail.google.com/,并把本邮箱加为测试用户;
//   3. 创建 Desktop 类型的 OAuth Client,把 client id / secret 填入根 .env。
// 用法:npm run gmail:oauth-setup(等价 npx tsx relayer/scripts/gmail-oauth-setup.ts)。
// 成功后把终端打印的 GMAIL_OAUTH_REFRESH_TOKEN=... 加入根 .env 即可。
import http from "node:http";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PORT = 8787;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPE = "https://mail.google.com/";

// tsx 不自动加载 .env:手动读取根 .env(不覆盖已存在的同名环境变量)
const ENV_PATH = path.resolve(__dirname, "../../.env");
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
}

const clientId = process.env.GMAIL_OAUTH_CLIENT_ID!;
const clientSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET!;
if (!clientId || !clientSecret) {
  console.error("缺少 GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET:请先填入根 .env 再重试");
  process.exit(1);
}

const consentUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
  }).toString();

const server = http.createServer((req, res) => {
  void handle(req, res);
});
let finished = false;

function respond(res: http.ServerResponse, code: number, text: string): void {
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function finish(code: number): void {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  // 稍等响应 flush 完毕再退出
  setTimeout(() => {
    server.close();
    process.exit(code);
  }, 100);
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname !== "/callback") {
    respond(res, 404, "not found");
    return;
  }
  const error = url.searchParams.get("error");
  if (error) {
    console.error(`授权被拒或失败: ${error}`);
    respond(res, 400, `authorization failed: ${error}`);
    return finish(1);
  }
  const code = url.searchParams.get("code");
  if (!code) {
    respond(res, 400, "missing code");
    return finish(1);
  }
  try {
    const body = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    });
    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const data: any = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${JSON.stringify(data)}`);
    if (!data.refresh_token) {
      throw new Error("响应缺少 refresh_token(该账号此前可能已授权过:请撤销该应用的访问权限后重跑,确保出现同意页)");
    }
    console.log("\n授权成功。把下面一行加入根 .env:\n");
    console.log(`GMAIL_OAUTH_REFRESH_TOKEN=${data.refresh_token}\n`);
    respond(res, 200, "authorized, you can close this tab");
    finish(0);
  } catch (e) {
    console.error(`换取 refresh token 失败: ${(e as Error).message}`);
    respond(res, 500, "token exchange failed, see terminal");
    finish(1);
  }
}

const timer = setTimeout(() => {
  if (finished) return;
  finished = true;
  console.error("5 分钟内未完成授权,退出");
  server.close();
  process.exit(1);
}, 5 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`请在浏览器中完成 Google 授权:\n\n  ${consentUrl}\n`);
  execFile("open", [consentUrl], () => {
    console.log("(无法自动打开浏览器的话,请手动复制上面的链接)");
  });
});
