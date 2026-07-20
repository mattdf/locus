import type {
  ChatCategory,
  ChatTree,
  InlineDefinition,
  InlineVisualization,
  Message,
  WorkspaceState,
} from "../types";
import { normalizeChatRevisions } from "./revisions";

export const CHAT_EXPORT_FORMAT = "locus-chat-export" as const;

export interface ChatExport {
  format: typeof CHAT_EXPORT_FORMAT;
  version: 1;
  exportedAt: string;
  scope:
    | { type: "all" }
    | { type: "category"; categoryId: string | null; name: string }
    | { type: "chat"; chatId: string; title: string };
  categories: ChatCategory[];
  chats: ChatTree[];
}

export interface ParsedChatImport {
  categories: ChatCategory[];
  chats: ChatTree[];
  scopeLabel: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMessage(value: unknown): value is Message {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.role === "user" || value.role === "assistant" || value.role === "source") &&
    typeof value.content === "string" &&
    typeof value.createdAt === "string"
  );
}

function isDefinition(value: unknown): value is InlineDefinition {
  if (!isRecord(value) || !isRecord(value.anchor)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.content === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.anchor.sourceNodeId === "string" &&
    typeof value.anchor.sourceMessageId === "string" &&
    typeof value.anchor.quote === "string" &&
    Number.isSafeInteger(value.anchor.blockIndex)
  );
}

function isVisualization(value: unknown): value is InlineVisualization {
  if (!isRecord(value) || !isRecord(value.anchor)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.hint === "string" &&
    (value.status === "draft" ||
      value.status === "generating" ||
      value.status === "compiling" ||
      value.status === "ready" ||
      value.status === "error") &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.anchor.sourceNodeId === "string" &&
    typeof value.anchor.sourceMessageId === "string" &&
    typeof value.anchor.quote === "string" &&
    Number.isSafeInteger(value.anchor.blockIndex) &&
    (value.engine === undefined || value.engine === "metapost" || value.engine === "tikz") &&
    (value.source === undefined || typeof value.source === "string") &&
    (value.metapostSource === undefined || typeof value.metapostSource === "string") &&
    (value.svg === undefined || typeof value.svg === "string")
  );
}

function isChat(value: unknown): value is ChatTree {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.rootId !== "string" ||
    !isRecord(value.nodes) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return false;
  }

  const nodes = Object.values(value.nodes);
  return (
    isRecord(value.nodes[value.rootId]) &&
    nodes.length > 0 &&
    nodes.every(
      (node) =>
        isRecord(node) &&
        typeof node.id === "string" &&
        (node.parentId === null || typeof node.parentId === "string") &&
        typeof node.title === "string" &&
        Array.isArray(node.messages) &&
        node.messages.every(isMessage) &&
        (node.definitions === undefined ||
          (Array.isArray(node.definitions) && node.definitions.every(isDefinition))) &&
        (node.visualizations === undefined ||
          (Array.isArray(node.visualizations) && node.visualizations.every(isVisualization))) &&
        typeof node.createdAt === "string" &&
        typeof node.updatedAt === "string",
    )
  );
}

function isCategory(value: unknown): value is ChatCategory {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function validatedPayload(
  categoriesValue: unknown,
  chatsValue: unknown,
  scopeLabel: string,
): ParsedChatImport {
  if (!Array.isArray(chatsValue) || !chatsValue.every(isChat)) {
    throw new Error("The chats in this file are invalid.");
  }
  if (categoriesValue !== undefined && !Array.isArray(categoriesValue)) {
    throw new Error("The categories in this file are invalid.");
  }
  const categories = (categoriesValue ?? []) as unknown[];
  if (!categories.every(isCategory)) {
    throw new Error("One or more categories in this file are invalid.");
  }
  if (!categories.length && !chatsValue.length) {
    throw new Error("This file does not contain any chats or categories.");
  }
  return { categories, chats: chatsValue, scopeLabel };
}

export function parseChatImport(source: string): ParsedChatImport {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("That file is not valid JSON.");
  }

  if (isRecord(value) && value.format === CHAT_EXPORT_FORMAT && value.version === 1) {
    const scope = isRecord(value.scope) ? value.scope : null;
    const scopeLabel =
      scope?.type === "chat"
        ? "Single chat export"
        : scope?.type === "category"
          ? "Category export"
          : "Full library export";
    return validatedPayload(value.categories, value.chats, scopeLabel);
  }

  // Accept the app's persisted workspace file as a convenient recovery/import format.
  if (isRecord(value) && value.version === 1 && Array.isArray(value.chats)) {
    return validatedPayload(value.categories, value.chats, "Workspace data file");
  }
  if (isChat(value)) return validatedPayload([], [value], "Single chat");
  if (Array.isArray(value) && value.every(isChat)) {
    return validatedPayload([], value, "Chat collection");
  }
  throw new Error("This is not a supported Locus chat export.");
}

export function makeChatExport(
  workspace: WorkspaceState,
  scope: ChatExport["scope"],
): ChatExport {
  if (scope.type === "all") {
    return {
      format: CHAT_EXPORT_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      scope,
      categories: workspace.categories,
      chats: workspace.chats,
    };
  }

  if (scope.type === "category") {
    return {
      format: CHAT_EXPORT_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      scope,
      categories: workspace.categories.filter((category) => category.id === scope.categoryId),
      chats: workspace.chats.filter(
        (chat) => (chat.categoryId ?? null) === scope.categoryId,
      ),
    };
  }

  const chat = workspace.chats.find((candidate) => candidate.id === scope.chatId);
  const category = chat?.categoryId
    ? workspace.categories.find((candidate) => candidate.id === chat.categoryId)
    : null;
  return {
    format: CHAT_EXPORT_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    scope,
    categories: category ? [category] : [],
    chats: chat ? [chat] : [],
  };
}

function safeFilename(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 70) || "locus-export"
  );
}

export function downloadChatExport(payload: ChatExport, name: string): void {
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeFilename(name)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function importedMessage(message: Message): Message {
  if (!message.pending) return { ...message };
  const { requestId: _requestId, ...rest } = message;
  return {
    ...rest,
    content: message.content || "Response stopped before the export completed.",
    pending: false,
    stopped: true,
  };
}

function importedDefinition(definition: InlineDefinition): InlineDefinition {
  if (!definition.pending) return { ...definition };
  const { requestId: _requestId, ...rest } = definition;
  return {
    ...rest,
    content: definition.content || "Definition stopped before the export completed.",
    pending: false,
    error: true,
  };
}

function importedVisualization(
  visualization: InlineVisualization,
): InlineVisualization {
  if (visualization.status !== "generating" && visualization.status !== "compiling") {
    return { ...visualization };
  }
  const { requestId: _requestId, ...rest } = visualization;
  return {
    ...rest,
    status: "error",
    errorStage: visualization.status === "compiling" ? "compile" : "model",
    errorMessage: `Visualization ${visualization.status} stopped before the export completed.`,
    updatedAt: new Date().toISOString(),
  };
}

export function cloneChatForImport(chat: ChatTree, id: string): ChatTree {
  const normalizedChat = normalizeChatRevisions(chat);
  return {
    ...normalizedChat,
    id,
    pinned: false,
    nodes: Object.fromEntries(
      Object.entries(normalizedChat.nodes).map(([nodeId, node]) => [
        nodeId,
        {
          ...node,
          messages: node.messages.map(importedMessage),
          definitions: node.definitions?.map(importedDefinition),
          visualizations: node.visualizations?.map(importedVisualization),
          messageRevisions: node.messageRevisions
            ? Object.fromEntries(
                Object.entries(node.messageRevisions).map(([groupId, group]) => [
                  groupId,
                  {
                    ...group,
                    variants: group.variants.map((variant) => ({
                      ...variant,
                      userMessage: importedMessage(variant.userMessage),
                      assistantMessage: importedMessage(variant.assistantMessage),
                    })),
                  },
                ]),
              )
            : undefined,
          responseRevisions: node.responseRevisions
            ? Object.fromEntries(
                Object.entries(node.responseRevisions).map(([groupId, group]) => [
                  groupId,
                  {
                    ...group,
                    responses: group.responses.map(importedMessage),
                  },
                ]),
              )
            : undefined,
        },
      ]),
    ),
  };
}
