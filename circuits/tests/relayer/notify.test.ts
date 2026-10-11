import { describe, expect, it, jest } from "@jest/globals";
import nodemailer from "nodemailer";
import { GmailNotifier, gmailAuthFromEnv } from "../../../relayer/notify";

jest.mock("nodemailer");

const sendMail = jest.fn<(...args: any[]) => any>().mockResolvedValue({ messageId: "x" });
(nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });

describe("GmailNotifier", () => {
  it("sends notification with Reply-To = relay address and claim url in body", async () => {
    const n = new GmailNotifier({ user: "penghe1996@gmail.com", auth: { kind: "appPassword", pass: "app-pass" } });
    await n.notify("friend@gmail.com", {
      escrow: "EscrowAddr111111111111111111111111111111",
      sender: "SenderAddr22222222222222222222222222222",
      amount: "50000000",
      claimUrl: "http://localhost:5173/claim/EscrowAddr111111111111111111111111111111",
    });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0][0];
    expect(mail.from).toContain("penghe1996@gmail.com");
    expect(mail.replyTo).toBe("penghe1996@gmail.com");
    expect(mail.to).toBe("friend@gmail.com");
    expect(mail.text).toContain("50000000");
    expect(mail.text).toContain("http://localhost:5173/claim/EscrowAddr");
    expect(mail.subject).toMatch(/^You received /);
  });

  it("creates SSL transport to gmail for app-password auth", () => {
    new GmailNotifier({ user: "u@gmail.com", auth: { kind: "appPassword", pass: "p" } });
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: { user: "u@gmail.com", pass: "p" },
      })
    );
  });

  it("creates gmail service transport with OAuth2 auth for oauth2 mode", async () => {
    const n = new GmailNotifier({
      user: "u@gmail.com",
      auth: { kind: "oauth2", clientId: "cid", clientSecret: "csec", refreshToken: "rt" },
    });
    expect(nodemailer.createTransport).toHaveBeenCalledWith({
      service: "gmail",
      auth: { type: "OAuth2", user: "u@gmail.com", clientId: "cid", clientSecret: "csec", refreshToken: "rt" },
    });
    await n.notify("friend@gmail.com", { escrow: "", sender: "", amount: "1", claimUrl: "http://x/claim/e" });
    const mail = sendMail.mock.calls[sendMail.mock.calls.length - 1][0];
    expect(mail.replyTo).toBe("u@gmail.com");
  });
});

describe("gmailAuthFromEnv", () => {
  it("returns oauth2 when all three oauth2 vars present", () => {
    const auth = gmailAuthFromEnv({
      GMAIL_OAUTH_CLIENT_ID: "cid",
      GMAIL_OAUTH_CLIENT_SECRET: "csec",
      GMAIL_OAUTH_REFRESH_TOKEN: "rt",
    });
    expect(auth).toEqual({ kind: "oauth2", clientId: "cid", clientSecret: "csec", refreshToken: "rt" });
  });

  it("prefers oauth2 over app password when both configured", () => {
    const auth = gmailAuthFromEnv({
      GMAIL_APP_PASSWORD: "pass",
      GMAIL_OAUTH_CLIENT_ID: "cid",
      GMAIL_OAUTH_CLIENT_SECRET: "csec",
      GMAIL_OAUTH_REFRESH_TOKEN: "rt",
    });
    expect(auth?.kind).toBe("oauth2");
  });

  it("returns appPassword when only GMAIL_APP_PASSWORD present", () => {
    expect(gmailAuthFromEnv({ GMAIL_APP_PASSWORD: "pass" })).toEqual({ kind: "appPassword", pass: "pass" });
  });

  it("returns null when neither configured", () => {
    expect(gmailAuthFromEnv({})).toBeNull();
  });

  it("returns appPassword when oauth2 vars incomplete (only refresh token)", () => {
    expect(gmailAuthFromEnv({ GMAIL_OAUTH_REFRESH_TOKEN: "rt", GMAIL_APP_PASSWORD: "pass" }))
      .toEqual({ kind: "appPassword", pass: "pass" });
  });
});
