import { describe, expect, it, jest } from "@jest/globals";
import nodemailer from "nodemailer";
import { GmailNotifier } from "../../../relayer/notify";

jest.mock("nodemailer");

const sendMail = jest.fn<(...args: any[]) => any>().mockResolvedValue({ messageId: "x" });
(nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });

describe("GmailNotifier", () => {
  it("sends notification with Reply-To = relay address and claim url in body", async () => {
    const n = new GmailNotifier({ user: "penghe1996@gmail.com", pass: "app-pass" });
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

  it("creates SSL transport to gmail", () => {
    new GmailNotifier({ user: "u@gmail.com", pass: "p" });
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: "smtp.gmail.com", port: 465, secure: true })
    );
  });
});
