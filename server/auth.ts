import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { admin } from "better-auth/plugins";
import { authSecret, isHosted, publicOrigin } from "./config.ts";
import { getPool } from "./db.ts";
import { deliverOnboardingEmail, prepareOnboardingEmail } from "./onboarding.ts";
import {
  sendEmailChangeConfirmation,
  sendVerificationEmail as sendLocusVerificationEmail,
} from "./postmark.ts";

export const auth = isHosted
  ? betterAuth({
      appName: "Locus Chat",
      baseURL: publicOrigin!,
      basePath: "/api/auth",
      secret: authSecret!,
      database: getPool(),
      trustedOrigins: [publicOrigin!],
      emailAndPassword: {
        enabled: true,
        // Account creation is routed through the server-enforced public/invite policy.
        disableSignUp: true,
        requireEmailVerification: true,
        autoSignIn: false,
        minPasswordLength: 12,
        maxPasswordLength: 128,
      },
      emailVerification: {
        sendOnSignUp: true,
        autoSignInAfterVerification: true,
        expiresIn: 60 * 60 * 24,
        beforeEmailVerification: async (user) => {
          await prepareOnboardingEmail(user.id);
        },
        afterEmailVerification: async (user) => {
          await deliverOnboardingEmail({
            userId: user.id,
            email: user.email,
            name: user.name,
            appUrl: publicOrigin!,
          });
        },
        sendVerificationEmail: async ({ user, url }) => {
          void sendLocusVerificationEmail({
            email: user.email,
            name: user.name,
            verificationUrl: url,
          })
            .then((result) => console.log(`[postmark] queued verification email ${result.messageId}`))
            .catch((error) => console.error(
              `[postmark] verification email failed: ${error instanceof Error ? error.message : "unknown error"}`,
            ));
        },
      },
      user: {
        changeEmail: {
          enabled: true,
          sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
            const result = await sendEmailChangeConfirmation({
              currentEmail: user.email,
              newEmail,
              name: user.name,
              confirmationUrl: url,
            });
            console.log(`[postmark] queued email-change confirmation ${result.messageId}`);
          },
        },
      },
      databaseHooks: {
        user: {
          update: {
            before: async (user) => {
              if (user.name === undefined) return;
              if (typeof user.name !== "string") {
                throw APIError.fromStatus("BAD_REQUEST", { message: "Enter a valid name" });
              }
              const name = user.name.trim();
              if (!name || name.length > 200) {
                throw APIError.fromStatus("BAD_REQUEST", {
                  message: "Name must contain 1–200 characters",
                });
              }
              return { data: { ...user, name } };
            },
          },
        },
      },
      session: {
        expiresIn: 60 * 60 * 24 * 30,
        updateAge: 60 * 60 * 24,
      },
      rateLimit: {
        enabled: true,
        window: 60,
        max: 100,
        customRules: {
          "/sign-in/email": { window: 60, max: 6 },
          "/sign-up/email": { window: 60 * 60, max: 5 },
          "/send-verification-email": { window: 60 * 10, max: 3 },
          "/change-email": { window: 60 * 60, max: 5 },
          "/change-password": { window: 60 * 10, max: 5 },
          "/update-user": { window: 60, max: 10 },
        },
      },
      advanced: {
        cookiePrefix: "locus",
        useSecureCookies: true,
        ipAddress: {
          // Only trust this after a private reverse proxy overwrites it from the connecting client.
          ipAddressHeaders: ["x-real-ip"],
        },
      },
      plugins: [admin({ bannedUserMessage: "This account is suspended." })],
    })
  : null;
