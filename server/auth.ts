import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import { authSecret, isHosted, publicOrigin } from "./config.ts";
import { getPool } from "./db.ts";

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
        disableSignUp: true,
        minPasswordLength: 12,
        maxPasswordLength: 128,
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
