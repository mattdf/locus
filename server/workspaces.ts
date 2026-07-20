import type { PoolClient } from "pg";
import type { ChatCategory, ChatTree, WorkspaceState } from "../src/types.ts";
import { normalizeChatRevisions } from "../src/lib/revisions.ts";
import { hostedLocalProviderEnabled } from "./config.ts";
import { getPool, transaction } from "./db.ts";
import { emptyState, normalizeState } from "./storage.ts";

export interface HostedWorkspaceSnapshot {
  state: WorkspaceState;
  revision: number;
}

export interface WorkspaceSyncInput {
  baseRevision: number;
  settings?: WorkspaceState["settings"];
  categories?: ChatCategory[];
  upsertChats?: ChatTree[];
  deleteChatIds?: string[];
  activeChatId?: string | null;
}

export class WorkspaceConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super("The workspace changed in another tab");
  }
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200;
}

function validateSync(input: WorkspaceSyncInput): void {
  if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) {
    throw new Error("A valid workspace revision is required");
  }
  if (input.categories && (input.categories.length > 10_000 || input.categories.some((item) => !validId(item?.id)))) {
    throw new Error("Invalid category update");
  }
  if (input.upsertChats && (input.upsertChats.length > 1_000 || input.upsertChats.some((item) => !validId(item?.id)))) {
    throw new Error("Invalid chat update");
  }
  if (input.deleteChatIds && (input.deleteChatIds.length > 10_000 || input.deleteChatIds.some((id) => !validId(id)))) {
    throw new Error("Invalid chat deletion");
  }
}

function hostedSafeState(state: WorkspaceState): WorkspaceState {
  const normalized = normalizeState(state);
  if (hostedLocalProviderEnabled || normalized.settings.provider !== "local") return normalized;
  return {
    ...normalized,
    settings: {
      ...normalized.settings,
      provider: "openai",
      model: normalized.settings.providerModels.openai,
    },
  };
}

async function ensureWorkspace(client: PoolClient, ownerUserId: string): Promise<void> {
  await client.query(
    `insert into "locus_workspace" ("ownerUserId") values ($1)
     on conflict ("ownerUserId") do nothing`,
    [ownerUserId],
  );
}

async function loadWithClient(
  client: Pick<PoolClient, "query">,
  ownerUserId: string,
): Promise<HostedWorkspaceSnapshot> {
  const [workspaceResult, settingsResult, categoryResult, chatResult] = await Promise.all([
    client.query<{ revision: string; activeChatId: string | null }>(
      `select "revision", "activeChatId" from "locus_workspace" where "ownerUserId" = $1`,
      [ownerUserId],
    ),
    client.query<{ settings: WorkspaceState["settings"] }>(
      `select "settings" from "locus_user_settings" where "ownerUserId" = $1`,
      [ownerUserId],
    ),
    client.query<{ document: ChatCategory }>(
      `select "document" from "locus_categories"
       where "ownerUserId" = $1 order by "position" asc`,
      [ownerUserId],
    ),
    client.query<{
      document: ChatTree;
      categoryId: string | null;
      title: string;
      pinned: boolean;
    }>(
      `select "document", "categoryId", "title", "pinned" from "locus_chats"
       where "ownerUserId" = $1 order by "updatedAt" desc`,
      [ownerUserId],
    ),
  ]);
  const fallback = emptyState();
  const workspace = workspaceResult.rows[0];
  const state = hostedSafeState({
    version: 1,
    categories: categoryResult.rows.map((row) => row.document),
    chats: chatResult.rows.map((row) => ({
      ...row.document,
      title: row.title,
      pinned: row.pinned,
      categoryId: row.categoryId,
    })),
    activeChatId: workspace?.activeChatId ?? null,
    settings: settingsResult.rows[0]?.settings ?? fallback.settings,
  });
  return { state, revision: Number(workspace?.revision ?? 0) };
}

export async function readHostedWorkspace(ownerUserId: string): Promise<HostedWorkspaceSnapshot> {
  await getPool().query(
    `insert into "locus_workspace" ("ownerUserId") values ($1)
     on conflict ("ownerUserId") do nothing`,
    [ownerUserId],
  );
  return loadWithClient(getPool(), ownerUserId);
}

export async function syncHostedWorkspace(
  ownerUserId: string,
  input: WorkspaceSyncInput,
): Promise<number> {
  validateSync(input);
  return transaction(async (client) => {
    await ensureWorkspace(client, ownerUserId);
    const locked = await client.query<{ revision: string }>(
      `select "revision" from "locus_workspace"
       where "ownerUserId" = $1 for update`,
      [ownerUserId],
    );
    const revision = Number(locked.rows[0].revision);
    if (revision !== input.baseRevision) throw new WorkspaceConflictError(revision);

    if (input.categories) {
      const categories = normalizeState({
        ...emptyState(),
        categories: input.categories,
      }).categories;
      const categoryIds = categories.map((category) => category.id);
      await client.query(
        `update "locus_chats" set "categoryId" = null
         where "ownerUserId" = $1
           and "categoryId" is not null
           and not ("categoryId" = any($2::text[]))`,
        [ownerUserId, categoryIds],
      );
      await client.query(`delete from "locus_categories" where "ownerUserId" = $1`, [ownerUserId]);
      for (const [position, category] of categories.entries()) {
        await client.query(
          `insert into "locus_categories"
             ("ownerUserId", "id", "name", "position", "document", "createdAt", "updatedAt")
           values ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
          [
            ownerUserId,
            category.id,
            category.name.slice(0, 500),
            position,
            JSON.stringify(category),
            category.createdAt,
            category.updatedAt,
          ],
        );
      }
    }

    if (input.settings) {
      const settings = hostedSafeState({ ...emptyState(), settings: input.settings }).settings;
      await client.query(
        `insert into "locus_user_settings" ("ownerUserId", "settings", "updatedAt")
         values ($1, $2::jsonb, current_timestamp)
         on conflict ("ownerUserId") do update
         set "settings" = excluded."settings", "updatedAt" = current_timestamp`,
        [ownerUserId, JSON.stringify(settings)],
      );
    }

    if (input.upsertChats?.length) {
      const categories = await client.query<{ id: string }>(
        `select "id" from "locus_categories" where "ownerUserId" = $1`,
        [ownerUserId],
      );
      const categoryIds = new Set(categories.rows.map((row) => row.id));
      for (const rawChat of input.upsertChats) {
        const chat = normalizeChatRevisions(rawChat);
        if (!chat || !validId(chat.rootId) || !chat.nodes?.[chat.rootId]) {
          throw new Error("Invalid chat tree");
        }
        const categoryId = chat.categoryId && categoryIds.has(chat.categoryId) ? chat.categoryId : null;
        const document = { ...chat, categoryId };
        await client.query(
          `insert into "locus_chats"
             ("ownerUserId", "id", "categoryId", "title", "pinned", "document", "createdAt", "updatedAt")
           values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
           on conflict ("ownerUserId", "id") do update set
             "categoryId" = excluded."categoryId",
             "title" = excluded."title",
             "pinned" = excluded."pinned",
             "document" = excluded."document",
             "version" = "locus_chats"."version" + 1,
             "updatedAt" = excluded."updatedAt"`,
          [
            ownerUserId,
            chat.id,
            categoryId,
            chat.title.slice(0, 2_000),
            chat.pinned === true,
            JSON.stringify(document),
            chat.createdAt,
            chat.updatedAt,
          ],
        );
      }
    }

    if (input.deleteChatIds?.length) {
      await client.query(
        `delete from "locus_chats" where "ownerUserId" = $1 and "id" = any($2::text[])`,
        [ownerUserId, [...new Set(input.deleteChatIds)]],
      );
    }

    const activeChatId =
      input.activeChatId === undefined
        ? undefined
        : input.activeChatId && validId(input.activeChatId)
          ? input.activeChatId
          : null;
    const nextRevision = revision + 1;
    await client.query(
      `update "locus_workspace"
       set "revision" = $2,
           "activeChatId" = case when $3::boolean then $4 else "activeChatId" end,
           "updatedAt" = current_timestamp
       where "ownerUserId" = $1`,
      [ownerUserId, nextRevision, activeChatId !== undefined, activeChatId ?? null],
    );
    return nextRevision;
  });
}
