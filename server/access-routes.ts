import express from "express";
import rateLimit from "express-rate-limit";
import { auth } from "./auth.ts";
import { isHosted } from "./config.ts";
import {
  AccessError,
  getAccessPolicy,
  joinWaitlist,
  publicInvite,
  registerAccount,
} from "./access.ts";

const accessLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

function hostedOnly(response: express.Response): boolean {
  if (isHosted && auth) return true;
  response.status(404).json({ error: "Not found" });
  return false;
}

function sendAccessError(error: unknown, response: express.Response): boolean {
  if (!(error instanceof AccessError)) return false;
  response.status(error.status).json({ error: error.message, code: error.code });
  return true;
}

export const accessRouter = express.Router();

accessRouter.get("/policy", async (_request, response, next) => {
  try {
    if (!hostedOnly(response)) return;
    response.setHeader("Cache-Control", "no-store");
    response.json(await getAccessPolicy());
  } catch (error) {
    next(error);
  }
});

accessRouter.get("/invites/:token", async (request, response, next) => {
  try {
    if (!hostedOnly(response)) return;
    response.setHeader("Cache-Control", "no-store");
    response.json({ invite: await publicInvite(request.params.token) });
  } catch (error) {
    if (!sendAccessError(error, response)) next(error);
  }
});

accessRouter.post("/waitlist", accessLimiter, async (request, response, next) => {
  try {
    if (!hostedOnly(response)) return;
    await joinWaitlist({
      email: typeof request.body?.email === "string" ? request.body.email : "",
      name: typeof request.body?.name === "string" ? request.body.name : "",
    });
    response.status(201).json({ joined: true });
  } catch (error) {
    if (!sendAccessError(error, response)) next(error);
  }
});

accessRouter.post("/signup", accessLimiter, async (request, response, next) => {
  try {
    if (!hostedOnly(response) || !auth) return;
    const hostedAuth = auth;
    const email = typeof request.body?.email === "string"
      ? request.body.email.trim().toLowerCase()
      : "";
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    const inviteToken = typeof request.body?.inviteToken === "string"
      ? request.body.inviteToken.trim()
      : undefined;
    const invited = Boolean(inviteToken);
    if (
      !name || name.length > 200 ||
      password.length < 12 || password.length > 128
    ) {
      response.status(400).json({ error: "Enter a valid name and password of 12–128 characters" });
      return;
    }

    const created = await registerAccount({
      email,
      inviteToken,
      createAccount: async () => {
        try {
          const result = await hostedAuth.api.createUser({
            body: {
              email,
              name,
              password,
              role: "user",
              // Possession of a valid, single-use invite is the verification step.
              // registerAccount validates and locks the invite before this callback runs.
              data: { emailVerified: invited },
            },
          });
          return { id: result.user.id, email: result.user.email };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Could not create the account";
          if (/already|exists|another email/i.test(message)) {
            throw new AccessError(409, "ACCOUNT_EXISTS", "An account with that email already exists");
          }
          throw error;
        }
      },
    });

    if (!invited) {
      await hostedAuth.api.sendVerificationEmail({
        body: { email: created.email, callbackURL: "/" },
      });
    }
    response.status(201).json({ created: true, verificationRequired: !invited });
  } catch (error) {
    if (!sendAccessError(error, response)) next(error);
  }
});
