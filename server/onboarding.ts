import { query } from "./db.ts";
import { sendOnboardingEmail } from "./postmark.ts";

export async function prepareOnboardingEmail(userId: string): Promise<void> {
  await query(
    `insert into "locus_onboarding_emails" ("ownerUserId", "status")
     values ($1, 'pending')
     on conflict ("ownerUserId") do nothing`,
    [userId],
  );
}

export async function deliverOnboardingEmail(input: {
  userId: string;
  email: string;
  name: string;
  appUrl: string;
}): Promise<void> {
  const claim = await query<{ ownerUserId: string }>(
    `update "locus_onboarding_emails"
     set "status" = 'sending', "updatedAt" = current_timestamp, "lastError" = null
     where "ownerUserId" = $1 and "status" = 'pending'
     returning "ownerUserId"`,
    [input.userId],
  );
  if (!claim.rowCount) return;

  try {
    const result = await sendOnboardingEmail({
      email: input.email,
      name: input.name,
      appUrl: input.appUrl,
    });
    await query(
      `update "locus_onboarding_emails"
       set "status" = 'sent', "postmarkMessageId" = $2, "sentAt" = current_timestamp,
           "updatedAt" = current_timestamp, "lastError" = null
       where "ownerUserId" = $1`,
      [input.userId, result.messageId],
    );
    console.log(`[postmark] queued onboarding email ${result.messageId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown onboarding email error";
    await query(
      `update "locus_onboarding_emails"
       set "status" = 'failed', "lastError" = $2, "updatedAt" = current_timestamp
       where "ownerUserId" = $1`,
      [input.userId, message.slice(0, 2000)],
    ).catch(() => undefined);
    console.error(`[postmark] onboarding email failed: ${message}`);
  }
}
