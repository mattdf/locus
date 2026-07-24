import express from "express";
import { requireAdmin, validIdentifier } from "./admin-auth.ts";
import {
  createInvite,
  getAccessPolicy,
  listInvites,
  listWaitlist,
  removeWaitlistEntry,
  revokeInvite,
  updateAccessPolicy,
} from "./access.ts";
import {
  createManagedCredential,
  listManagedCredentials,
  revokeManagedCredential,
  updateManagedCredentialLimit,
} from "./credentials.ts";
import { abortOwnerGenerations } from "./generations.ts";

export const adminAccessRouter = express.Router();

function managedKeyLimit(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 10_000_000
  ) {
    throw new Error("The monthly managed-key limit must be between $0 and $10,000,000");
  }
  return value;
}

adminAccessRouter.get("/", async (_request, response, next) => {
  try {
    if (!requireAdmin(response)) return;
    const [policy, invites, managedCredentials, waitlist] = await Promise.all([
      getAccessPolicy(),
      listInvites(),
      listManagedCredentials(),
      listWaitlist(),
    ]);
    response.setHeader("Cache-Control", "no-store");
    response.json({ policy, invites, managedCredentials, waitlist });
  } catch (error) {
    next(error);
  }
});

adminAccessRouter.patch("/settings", async (request, response, next) => {
  try {
    const administrator = requireAdmin(response);
    if (!administrator) return;
    if (typeof request.body?.publicSignupEnabled !== "boolean") {
      response.status(400).json({ error: "Specify whether public signup is enabled" });
      return;
    }
    const policy = await updateAccessPolicy(request.body.publicSignupEnabled, administrator.id);
    console.log(`[admin] ${administrator.email} set signup mode to ${policy.signupMode}`);
    response.json({ policy });
  } catch (error) {
    next(error);
  }
});

adminAccessRouter.post("/managed-credentials", async (request, response, next) => {
  try {
    const administrator = requireAdmin(response);
    if (!administrator) return;
    const credential = await createManagedCredential({
      provider: request.body?.provider,
      label: typeof request.body?.label === "string" ? request.body.label : "",
      apiKey: typeof request.body?.apiKey === "string" ? request.body.apiKey : "",
      monthlyLimitUsd: managedKeyLimit(request.body?.monthlyLimitUsd),
      administratorUserId: administrator.id,
    });
    console.log(`[admin] ${administrator.email} created managed ${credential.provider} key ${credential.id}`);
    response.status(201).json({ credential });
  } catch (error) {
    if (
      error instanceof Error &&
      /managed keys|key label|valid API key|monthly managed-key limit/i.test(error.message)
    ) {
      response.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

adminAccessRouter.patch("/managed-credentials/:credentialId", async (request, response, next) => {
  try {
    const administrator = requireAdmin(response);
    if (!administrator) return;
    if (!validIdentifier(request.params.credentialId)) {
      response.status(400).json({ error: "Invalid key identifier" });
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(request.body ?? {}, "monthlyLimitUsd")) {
      response.status(400).json({ error: "Specify a monthly managed-key limit" });
      return;
    }
    const credential = await updateManagedCredentialLimit(
      request.params.credentialId,
      managedKeyLimit(request.body.monthlyLimitUsd),
    );
    if (!credential) {
      response.status(404).json({ error: "Active managed key not found" });
      return;
    }
    console.log(
      `[admin] ${administrator.email} updated the monthly limit for managed key ${credential.id}`,
    );
    response.json({ credential });
  } catch (error) {
    if (error instanceof Error && /monthly managed-key limit/i.test(error.message)) {
      response.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

adminAccessRouter.delete("/managed-credentials/:credentialId", async (request, response, next) => {
  try {
    const administrator = requireAdmin(response);
    if (!administrator) return;
    if (!validIdentifier(request.params.credentialId)) {
      response.status(400).json({ error: "Invalid key identifier" });
      return;
    }
    const assignedUserIds = await revokeManagedCredential(request.params.credentialId, administrator.id);
    if (!assignedUserIds) {
      response.status(404).json({ error: "Active managed key not found" });
      return;
    }
    assignedUserIds.forEach((ownerUserId) => abortOwnerGenerations(ownerUserId));
    console.log(
      `[admin] ${administrator.email} revoked managed key ${request.params.credentialId} for ${assignedUserIds.length} accounts`,
    );
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

adminAccessRouter.post("/invites", async (request, response, next) => {
  try {
    const administrator = requireAdmin(response);
    if (!administrator) return;
    const expiresInDays = request.body?.expiresInDays === null
      ? null
      : Number(request.body?.expiresInDays ?? 7);
    const result = await createInvite({
      administratorUserId: administrator.id,
      email: typeof request.body?.email === "string" ? request.body.email : undefined,
      expiresInDays,
      managedCredentialId: typeof request.body?.managedCredentialId === "string"
        ? request.body.managedCredentialId
        : null,
      accountMonthlyLimitUsd: managedKeyLimit(request.body?.accountMonthlyLimitUsd),
    });
    console.log(`[admin] ${administrator.email} created invite ${result.invite.id}`);
    response.status(201).json(result);
  } catch (error) {
    if (error instanceof Error && "status" in error && typeof error.status === "number") {
      response.status(error.status).json({ error: error.message });
      return;
    }
    next(error);
  }
});

adminAccessRouter.delete("/invites/:inviteId", async (request, response, next) => {
  try {
    const administrator = requireAdmin(response);
    if (!administrator) return;
    if (!validIdentifier(request.params.inviteId)) {
      response.status(400).json({ error: "Invalid invite identifier" });
      return;
    }
    const revoked = await revokeInvite(request.params.inviteId, administrator.id);
    if (!revoked) {
      response.status(404).json({ error: "Active invite not found" });
      return;
    }
    console.log(`[admin] ${administrator.email} revoked invite ${request.params.inviteId}`);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

adminAccessRouter.delete("/waitlist/:entryId", async (request, response, next) => {
  try {
    if (!requireAdmin(response)) return;
    if (!validIdentifier(request.params.entryId)) {
      response.status(400).json({ error: "Invalid waitlist identifier" });
      return;
    }
    if (!(await removeWaitlistEntry(request.params.entryId))) {
      response.status(404).json({ error: "Waitlist entry not found" });
      return;
    }
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});
