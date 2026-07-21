import type express from "express";
import { auth } from "./auth.ts";
import { isHosted } from "./config.ts";

export interface AdministratorIdentity {
  id: string;
  email: string;
}

export function isAdministrator(role: unknown): boolean {
  return typeof role === "string" && role.split(",").includes("admin");
}

export function requireAdmin(response: express.Response): AdministratorIdentity | null {
  if (!isHosted || !auth) {
    response.status(404).json({ error: "Not found" });
    return null;
  }
  const user = response.locals.user as {
    id?: unknown;
    email?: unknown;
    role?: unknown;
  } | undefined;
  if (
    typeof user?.id !== "string" ||
    typeof user.email !== "string" ||
    !isAdministrator(user.role)
  ) {
    response.status(403).json({ error: "Administrator access required" });
    return null;
  }
  return { id: user.id, email: user.email };
}

export function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}
