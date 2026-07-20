import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import { authSecret, isHosted, publicOrigin } from "./config.ts";
import { getPool } from "./db.ts";
import { sendVerificationEmail as sendLocusVerificationEmail } from "./postmark.ts";

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
        disableSignUp: false,
        requireEmailVerification: true,
        autoSignIn: false,
        minPasswordLength: 12,
        maxPasswordLength: 128,
      },
      emailVerification: {
        sendOnSignUp: true,
        autoSignInAfterVerification: true,
        expiresIn: 60 * 60 * 24,
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
        },
      },
      advanced: {
        cookiePrefix: "locus",
        useSecureCookies: true,
        ipAddress: {
          // Coolify's Traefik proxy overwrites this header; the app service has no published port.
          ipAddressHeaders: ["x-real-ip"],
        },
      },
      plugins: [admin()],
    })
  : null;
