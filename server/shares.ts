import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import type {
  ChatTree,
  InlineDefinition,
  InlineElaboration,
  InlineVisualization,
  Message,
  ThreadNode,
} from "../src/types.ts";
import { messagesForNode } from "../src/lib/tree.ts";
import { isHosted } from "./config.ts";
import { query } from "./db.ts";

interface StoredChatRow {
  document: ChatTree;
  title: string;
}

interface SharedChatRow {
  id: string;
  sourceChatId: string | null;
  token: string;
  title: string;
  snapshot: ChatTree;
  createdAt: Date | string;
}

export interface SharedChatSummary {
  id: string;
  sourceChatId: string | null;
  title: string;
  path: string;
  createdAt: string;
}

function owner(response: express.Response): string {
  return String(response.locals.ownerUserId ?? "");
}

function completedMessage(message: Message): Message | null {
  if (!message.content.trim()) return null;
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    ...(message.error ? { error: true } : {}),
    ...(message.stopped ? { stopped: true } : {}),
    ...(message.generation ? { generation: message.generation } : {}),
  };
}

function completedDefinition(definition: InlineDefinition): InlineDefinition | null {
  if (definition.pending || definition.error || !definition.content.trim()) return null;
  const {
    pending: _pending,
    error: _error,
    requestId: _requestId,
    hint: _hint,
    draft: _draft,
    ...rest
  } = definition;
  return rest;
}

function completedVisualization(
  visualization: InlineVisualization,
): InlineVisualization | null {
  if (visualization.status !== "ready" || !visualization.svg?.trim()) return null;
  const {
    requestId: _requestId,
    compilerLog: _compilerLog,
    errorStage: _errorStage,
    errorMessage: _errorMessage,
    ...rest
  } = visualization;
  return rest;
}

function completedInlineElaboration(
  elaboration: InlineElaboration,
): InlineElaboration | null {
  if (elaboration.pending || elaboration.error || !elaboration.content.trim()) return null;
  const {
    requestId: _requestId,
    hint: _hint,
    pending: _pending,
    error: _error,
    ...rest
  } = elaboration;
  return { ...rest, hint: "" };
}

/**
 * A share is a snapshot of the currently selected path through every message
 * revision group. Hidden revisions and unfinished model work are deliberately
 * omitted from the public document.
 */
export function createPublicSnapshot(chat: ChatTree): ChatTree {
  const nodes = Object.fromEntries(
    Object.values(chat.nodes).map((node): [string, ThreadNode] => {
      const messages = messagesForNode(node)
        .map(completedMessage)
        .filter((message): message is Message => Boolean(message));
      const definitions = (node.definitions ?? [])
        .map(completedDefinition)
        .filter((definition): definition is InlineDefinition => Boolean(definition));
      const visualizations = (node.visualizations ?? [])
        .map(completedVisualization)
        .filter((visualization): visualization is InlineVisualization => Boolean(visualization));
      const inlineElaborations = (node.inlineElaborations ?? [])
        .map(completedInlineElaboration)
        .filter((elaboration): elaboration is InlineElaboration => Boolean(elaboration));
      return [
        node.id,
        {
          id: node.id,
          parentId: node.parentId,
          title: node.title,
          ...(node.anchor ? { anchor: node.anchor } : {}),
          messages,
          definitions,
          visualizations,
          inlineElaborations,
          createdAt: node.createdAt,
          updatedAt: node.updatedAt,
        },
      ];
    }),
  );
  return {
    ...chat,
    categoryId: null,
    pinned: false,
    nodes,
  };
}

function summary(row: Omit<SharedChatRow, "snapshot">): SharedChatSummary {
  return {
    id: row.id,
    sourceChatId: row.sourceChatId,
    title: row.title,
    path: `/share/${row.token}`,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

export const publicSharesRouter = express.Router();

publicSharesRouter.get("/:token", async (request, response, next) => {
  try {
    if (!isHosted || !/^[A-Za-z0-9_-]{43}$/.test(request.params.token)) {
      response.status(404).json({ error: "Shared chat not found" });
      return;
    }
    const result = await query<SharedChatRow>(
      `select "id", "sourceChatId", "token", "title", "snapshot", "createdAt"
       from "locus_shared_chats" where "token" = $1`,
      [request.params.token],
    );
    const share = result.rows[0];
    if (!share) {
      response.status(404).json({ error: "Shared chat not found" });
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.json({
      title: share.title,
      createdAt: new Date(share.createdAt).toISOString(),
      chat: share.snapshot,
    });
  } catch (error) {
    next(error);
  }
});

export const sharesRouter = express.Router();

sharesRouter.get("/", async (_request, response, next) => {
  try {
    if (!isHosted) {
      response.status(404).json({ error: "Sharing is only available in hosted mode" });
      return;
    }
    const result = await query<Omit<SharedChatRow, "snapshot">>(
      `select "id", "sourceChatId", "token", "title", "createdAt"
       from "locus_shared_chats"
       where "ownerUserId" = $1
       order by "createdAt" desc`,
      [owner(response)],
    );
    response.setHeader("Cache-Control", "no-store");
    response.json({ shares: result.rows.map(summary) });
  } catch (error) {
    next(error);
  }
});

sharesRouter.post("/", async (request, response, next) => {
  try {
    if (!isHosted) {
      response.status(404).json({ error: "Sharing is only available in hosted mode" });
      return;
    }
    const chatId = typeof request.body?.chatId === "string" ? request.body.chatId : "";
    if (!chatId || chatId.length > 200) {
      response.status(400).json({ error: "A valid chat is required" });
      return;
    }
    const chatResult = await query<StoredChatRow>(
      `select "document", "title" from "locus_chats"
       where "ownerUserId" = $1 and "id" = $2`,
      [owner(response), chatId],
    );
    const stored = chatResult.rows[0];
    if (!stored) {
      response.status(404).json({ error: "Chat not found" });
      return;
    }

    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const title = stored.title.slice(0, 2_000);
    const snapshot = createPublicSnapshot({ ...stored.document, title });
    const inserted = await query<Omit<SharedChatRow, "snapshot">>(
      `insert into "locus_shared_chats"
         ("id", "ownerUserId", "sourceChatId", "token", "title", "snapshot")
       values ($1, $2, $3, $4, $5, $6::jsonb)
       returning "id", "sourceChatId", "token", "title", "createdAt"`,
      [id, owner(response), chatId, token, title, JSON.stringify(snapshot)],
    );
    response.setHeader("Cache-Control", "no-store");
    response.status(201).json({ share: summary(inserted.rows[0]) });
  } catch (error) {
    next(error);
  }
});

sharesRouter.delete("/:id", async (request, response, next) => {
  try {
    if (!isHosted || !/^[0-9a-f-]{36}$/i.test(request.params.id)) {
      response.status(404).json({ error: "Shared chat not found" });
      return;
    }
    const result = await query(
      `delete from "locus_shared_chats"
       where "id" = $1 and "ownerUserId" = $2`,
      [request.params.id, owner(response)],
    );
    if (!result.rowCount) {
      response.status(404).json({ error: "Shared chat not found" });
      return;
    }
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});
