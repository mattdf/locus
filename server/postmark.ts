import { postmarkFrom, postmarkServerToken } from "./config.ts";

const POSTMARK_EMAIL_ENDPOINT = "https://api.postmarkapp.com/email";
const POSTMARK_MESSAGE_STREAM = process.env.POSTMARK_MESSAGE_STREAM?.trim() || "outbound";

interface PostmarkResponse {
  ErrorCode?: number;
  Message?: string;
  MessageID?: string;
  SubmittedAt?: string;
  To?: string;
}

export interface PostmarkSendResult {
  messageId: string;
  submittedAt?: string;
}

function html(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export async function sendPostmarkEmail(input: {
  to: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  tag?: string;
}): Promise<PostmarkSendResult> {
  if (!postmarkServerToken) {
    throw new Error("POSTMARK_SERVER_TOKEN is not configured");
  }
  const response = await fetch(POSTMARK_EMAIL_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": postmarkServerToken,
    },
    body: JSON.stringify({
      From: postmarkFrom,
      To: input.to,
      Subject: input.subject,
      TextBody: input.textBody,
      HtmlBody: input.htmlBody,
      MessageStream: POSTMARK_MESSAGE_STREAM,
      TrackOpens: false,
      TrackLinks: "None",
      ...(input.tag ? { Tag: input.tag } : {}),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const result = (await response.json().catch(() => ({}))) as PostmarkResponse;
  if (!response.ok || result.ErrorCode !== 0 || !result.MessageID) {
    throw new Error(
      `Postmark rejected the email${result.ErrorCode ? ` (${result.ErrorCode})` : ""}: ${result.Message ?? `HTTP ${response.status}`}`,
    );
  }
  return { messageId: result.MessageID, submittedAt: result.SubmittedAt };
}

export async function sendVerificationEmail(input: {
  email: string;
  name: string;
  verificationUrl: string;
}): Promise<PostmarkSendResult> {
  const safeName = html(input.name.trim() || "there");
  const safeUrl = html(input.verificationUrl);
  return sendPostmarkEmail({
    to: input.email,
    subject: "Verify your Locus Chat email",
    tag: "email-verification",
    textBody: `Hi ${input.name.trim() || "there"},\n\nConfirm this email address for your Locus Chat account:\n\n${input.verificationUrl}\n\nThis link expires in 24 hours. If you did not request this, you can ignore this email.`,
    htmlBody: `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f3ef;color:#28312d;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f3ef;padding:32px 16px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fffefa;border:1px solid #d9d9d2;border-radius:12px">
          <tr><td style="padding:32px">
            <div style="font-family:Georgia,'Times New Roman',serif;font-size:28px;color:#1d2926">Locus Chat</div>
            <h1 style="margin:28px 0 12px;font-size:22px;line-height:1.3;color:#1d2926">Verify your email</h1>
            <p style="margin:0 0 18px;font-size:15px;line-height:1.6">Hi ${safeName},</p>
            <p style="margin:0 0 24px;font-size:15px;line-height:1.6">Confirm this email address for your private Locus Chat account.</p>
            <p style="margin:0 0 26px">
              <a href="${safeUrl}" style="display:inline-block;padding:12px 18px;background:#2f6d59;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:700">Verify email</a>
            </p>
            <p style="margin:0 0 8px;color:#6d7772;font-size:12px;line-height:1.6">This link expires in 24 hours. If you did not request this, you can ignore this email.</p>
            <p style="margin:0;color:#8a918e;font-size:11px;line-height:1.5;word-break:break-all">If the button does not work, open: ${safeUrl}</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`,
  });
}

export async function sendEmailChangeConfirmation(input: {
  currentEmail: string;
  newEmail: string;
  name: string;
  confirmationUrl: string;
}): Promise<PostmarkSendResult> {
  const name = input.name.trim() || "there";
  const safeName = html(name);
  const safeNewEmail = html(input.newEmail);
  const safeUrl = html(input.confirmationUrl);
  return sendPostmarkEmail({
    to: input.currentEmail,
    subject: "Confirm your Locus Chat email change",
    tag: "email-change-confirmation",
    textBody: `Hi ${name},\n\nA request was made to change your Locus Chat sign-in email to ${input.newEmail}.\n\nConfirm the change here:\n\n${input.confirmationUrl}\n\nAfter you confirm, we will send a verification link to the new address. If you did not request this change, ignore this email and your current address will remain unchanged.`,
    htmlBody: `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f3ef;color:#28312d;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f3ef;padding:32px 16px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fffefa;border:1px solid #d9d9d2;border-radius:12px">
          <tr><td style="padding:32px">
            <div style="font-family:Georgia,'Times New Roman',serif;font-size:28px;color:#1d2926">Locus Chat</div>
            <h1 style="margin:28px 0 12px;font-size:22px;line-height:1.3;color:#1d2926">Confirm your email change</h1>
            <p style="margin:0 0 18px;font-size:15px;line-height:1.6">Hi ${safeName},</p>
            <p style="margin:0 0 24px;font-size:15px;line-height:1.6">A request was made to change your sign-in email to <strong>${safeNewEmail}</strong>.</p>
            <p style="margin:0 0 26px">
              <a href="${safeUrl}" style="display:inline-block;padding:12px 18px;background:#2f6d59;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:700">Confirm email change</a>
            </p>
            <p style="margin:0 0 8px;color:#6d7772;font-size:12px;line-height:1.6">After confirmation, we will verify the new address. If you did not request this change, ignore this email and your current address will remain unchanged.</p>
            <p style="margin:0;color:#8a918e;font-size:11px;line-height:1.5;word-break:break-all">If the button does not work, open: ${safeUrl}</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`,
  });
}

export async function sendOnboardingEmail(input: {
  email: string;
  name: string;
  appUrl: string;
}): Promise<PostmarkSendResult> {
  const name = input.name.trim() || "there";
  const safeName = html(name);
  const safeUrl = html(input.appUrl);
  return sendPostmarkEmail({
    to: input.email,
    subject: "Welcome to Locus Chat",
    tag: "account-onboarding",
    textBody: `Hi ${name},

Your email is verified and your Locus Chat account is ready.

To get started:

1. Open Providers and choose model connections for chat, definitions, visualizations, and rewrites. Add API keys if your invite does not include managed access.
2. Start a new chat, or import existing Markdown without making a model call.
3. Highlight any passage or equation to elaborate, define, quote, or visualize it.

Elaborations stay attached to their source and can branch recursively, so you can explore a detail without losing the main thread.

Open Locus Chat: ${input.appUrl}`,
    htmlBody: `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f3ef;color:#28312d;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f3ef;padding:32px 16px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fffefa;border:1px solid #d9d9d2;border-radius:12px">
          <tr><td style="padding:32px">
            <div style="font-family:Georgia,'Times New Roman',serif;font-size:28px;color:#1d2926">Locus Chat</div>
            <h1 style="margin:28px 0 12px;font-size:22px;line-height:1.3;color:#1d2926">Your account is ready</h1>
            <p style="margin:0 0 18px;font-size:15px;line-height:1.6">Hi ${safeName},</p>
            <p style="margin:0 0 22px;font-size:15px;line-height:1.6">Your email is verified and your Locus Chat account is ready.</p>
            <p style="margin:0 0 10px;font-size:15px;font-weight:700;line-height:1.5">To get started:</p>
            <ol style="margin:0 0 24px;padding-left:22px;font-size:15px;line-height:1.7">
              <li style="margin-bottom:8px">Open Providers and choose model connections for chat, definitions, visualizations, and rewrites. Add API keys if your invite does not include managed access.</li>
              <li style="margin-bottom:8px">Start a new chat, or import existing Markdown without making a model call.</li>
              <li>Highlight any passage or equation to elaborate, define, quote, or visualize it.</li>
            </ol>
            <p style="margin:0 0 24px;font-size:15px;line-height:1.6">Elaborations stay attached to their source and can branch recursively, so you can explore a detail without losing the main thread.</p>
            <p style="margin:0">
              <a href="${safeUrl}" style="display:inline-block;padding:12px 18px;background:#2f6d59;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:700">Open Locus Chat</a>
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`,
  });
}
