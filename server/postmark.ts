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
    textBody: `Hi ${input.name.trim() || "there"},\n\nVerify your email to finish creating your Locus Chat account:\n\n${input.verificationUrl}\n\nThis link expires in 24 hours. If you did not request this account, you can ignore this email.`,
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
            <p style="margin:0 0 24px;font-size:15px;line-height:1.6">Confirm this email address to finish creating your private Locus Chat account.</p>
            <p style="margin:0 0 26px">
              <a href="${safeUrl}" style="display:inline-block;padding:12px 18px;background:#2f6d59;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:700">Verify email</a>
            </p>
            <p style="margin:0 0 8px;color:#6d7772;font-size:12px;line-height:1.6">This link expires in 24 hours. If you did not request this account, you can ignore this email.</p>
            <p style="margin:0;color:#8a918e;font-size:11px;line-height:1.5;word-break:break-all">If the button does not work, open: ${safeUrl}</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`,
  });
}
