import nodemailer, { type Transporter } from "nodemailer";

/**
 * Outgoing email (sign-in links, invitations) over SMTP — works with any
 * provider (Postmark, Amazon SES, Brevo, Mailgun, a Hetzner mailbox…).
 *
 *   SMTP_URL   smtp://user:pass@smtp.example.com:587  (smtps://… for port 465)
 *   MAIL_FROM  "day2 <hello@example.com>"
 *
 * In development without SMTP_URL, messages are printed to the server log
 * instead, so sign-in links can still be followed. Production never does
 * that: without SMTP, email sign-in simply isn't offered.
 */

export type Mail = { to: string; subject: string; text: string; html: string };

export function mailConfigured(): boolean {
  return Boolean(process.env.SMTP_URL);
}

/** Email sign-in is offered when mail can be delivered (or printed, in development). */
export function emailSignInAvailable(): boolean {
  return mailConfigured() || process.env.NODE_ENV !== "production";
}

let transport: Transporter | null = null;
let sender: ((m: Mail) => Promise<void>) | null = null;

/** Tests capture mail here instead of sending it. */
export function setMailSender(fn: ((m: Mail) => Promise<void>) | null): void {
  sender = fn;
}

export async function sendMail(m: Mail): Promise<void> {
  if (sender) return sender(m);
  if (!mailConfigured()) {
    if (process.env.NODE_ENV === "production") throw new Error("Email isn't set up on this server (SMTP_URL).");
    console.log(`[day2-mail] SMTP_URL not set — not sent.\n  To: ${m.to}\n  Subject: ${m.subject}\n\n${m.text}\n`);
    return;
  }
  transport ??= nodemailer.createTransport(process.env.SMTP_URL!);
  await transport.sendMail({ from: process.env.MAIL_FROM ?? "day2 <no-reply@localhost>", to: m.to, subject: m.subject, text: m.text, html: m.html });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function layout(heading: string, body: string, button: { label: string; url: string }, footer: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f5f5f3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111110">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:24px;padding:32px">
<tr><td style="font-size:15px;font-weight:600;padding-bottom:24px">day2</td></tr>
<tr><td style="font-size:24px;font-weight:600;line-height:1.25;padding-bottom:12px">${esc(heading)}</td></tr>
<tr><td style="font-size:15px;line-height:1.5;color:#4a4a47;padding-bottom:24px">${body}</td></tr>
<tr><td style="padding-bottom:24px"><a href="${esc(button.url)}" style="display:inline-block;background:#111110;color:#ffffff;text-decoration:none;font-size:15px;font-weight:500;padding:12px 22px;border-radius:999px">${esc(button.label)}</a></td></tr>
<tr><td style="font-size:13px;line-height:1.5;color:#8a8a85">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}

export function signInLinkMail(to: string, url: string, minutes: number): Mail {
  return {
    to,
    subject: "Your day2 sign-in link",
    text: `Sign in to day2:\n\n${url}\n\nThe link works once, for ${minutes} minutes. If you didn't ask for it, ignore this email — nothing happens.`,
    html: layout(
      "Sign in to day2",
      "Use the button below to sign in. No password needed.",
      { label: "Sign in", url },
      `The link works once, for ${minutes} minutes. If you didn't ask for it, ignore this email — nothing happens.<br><br>Or paste this into your browser:<br><span style="word-break:break-all">${esc(url)}</span>`,
    ),
  };
}

export function inviteMail(to: string, inviter: string, workspace: string, url: string, days: number): Mail {
  return {
    to,
    subject: `${inviter} invited you to ${workspace} on day2`,
    text: `${inviter} invited you to the ${workspace} workspace on day2.\n\nSign in with this email address (or with Google or GitHub using the same address) to join:\n\n${url}\n\nThe invitation is valid for ${days} days.`,
    html: layout(
      `Join ${workspace} on day2`,
      `${esc(inviter)} invited you to the <strong>${esc(workspace)}</strong> workspace. Sign in with this email address — or with Google or GitHub using the same address — to join.`,
      { label: "Join the workspace", url },
      `The invitation is valid for ${days} days.`,
    ),
  };
}
