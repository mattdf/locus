import type { ChatTree, ContextNode, Message, ThreadNode } from "../types";

export const newId = () => crypto.randomUUID();
export const timestamp = () => new Date().toISOString();

export function threadPath(chat: ChatTree, nodeId: string): ThreadNode[] {
  const path: ThreadNode[] = [];
  let current: ThreadNode | undefined = chat.nodes[nodeId];
  const seen = new Set<string>();

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parentId ? chat.nodes[current.parentId] : undefined;
  }
  return path;
}

export function contextFor(
  chat: ChatTree,
  nodeId: string,
  excludedMessageIds: string[] = [],
): ContextNode[] {
  const excluded = new Set(excludedMessageIds);
  return threadPath(chat, nodeId).map((node) => ({
    title: node.title,
    messages: messagesForNode(node)
      .filter(
        (message) =>
          !excluded.has(message.id) &&
          !message.pending &&
          !message.error &&
          message.content.trim(),
      )
      .map(({ role, content }) => ({ role, content })),
  }));
}

export function messagesForNode(node: ThreadNode): Message[] {
  const groups = Object.values(node.messageRevisions ?? {});
  return node.messages.map((message) => {
    const group = groups.find(
      (candidate) =>
        candidate.userMessageId === message.id || candidate.assistantMessageId === message.id,
    );
    const active = group
      ? group.variants.find((variant) => variant.id === group.activeVariantId) ??
        group.variants[0]
      : undefined;
    let resolved = message;
    if (active && message.id === group?.userMessageId) {
      resolved = {
        ...active.userMessage,
        revisionGroupId: group.userMessageId,
        revisionVariantId: active.id,
      };
    } else if (active && message.id === group?.assistantMessageId) {
      resolved = {
        ...active.assistantMessage,
        revisionGroupId: group.userMessageId,
        revisionVariantId: active.id,
      };
    }

    if (resolved.role !== "assistant") return resolved;
    const responseGroup = node.responseRevisions?.[resolved.id];
    const activeResponse = responseGroup
      ? responseGroup.responses.find(
          (response) => response.id === responseGroup.activeResponseId,
        ) ?? responseGroup.responses[0]
      : undefined;
    if (responseGroup && activeResponse) {
      resolved = {
        ...activeResponse,
        revisionGroupId: resolved.revisionGroupId,
        revisionVariantId: resolved.revisionVariantId,
        responseRevisionGroupId: responseGroup.assistantMessageId,
      };
    }

    return {
      ...resolved,
      content: activeEditContent(node, resolved.id, resolved.content),
    };
  });
}

/** Resolves the selected immutable rewrite leaf for any generated content entity. */
export function activeEditContent(
  node: ThreadNode,
  contentId: string,
  originalContent: string,
): string {
  const editGroup = node.assistantEdits?.[contentId];
  const activeEdit = editGroup
    ? editGroup.variants.find((variant) => variant.id === editGroup.activeVariantId) ??
      editGroup.variants[0]
    : undefined;
  return activeEdit?.content ?? originalContent;
}

export function contextBeforeMessage(
  chat: ChatTree,
  nodeId: string,
  messageId: string,
): ContextNode[] {
  return threadPath(chat, nodeId).map((node) => {
    let messages = messagesForNode(node);
    if (node.id === nodeId) {
      const index = node.messages.findIndex((message) => message.id === messageId);
      messages = index >= 0 ? messages.slice(0, index) : messages;
    }
    return {
      title: node.title,
      messages: messages
        .filter(
          (message) =>
            !message.pending && !message.error && message.content.trim(),
        )
        .map(({ role, content }) => ({ role, content })),
    };
  });
}

export function childThreads(chat: ChatTree, nodeId: string): ThreadNode[] {
  return Object.values(chat.nodes).filter((node) => node.parentId === nodeId);
}

export function treeDepth(chat: ChatTree): number {
  return Math.max(0, ...Object.keys(chat.nodes).map((id) => threadPath(chat, id).length - 1));
}

const TITLE_MATH_PATTERN =
  /(\$\$[\s\S]*?\$\$|(?<!\\)\$(?!\$)[\s\S]*?(?<!\\)\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\])/g;

function cleanTitleMarkdown(text: string): string {
  return text
    .split(TITLE_MATH_PATTERN)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(/[*_`]/g, "")))
    .join("");
}

function truncateTitleWithoutBreakingMath(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const parts = text.split(TITLE_MATH_PATTERN);
  let result = "";
  let truncated = false;

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] ?? "";
    if (!part) continue;
    const isMath = index % 2 === 1;
    if (isMath) {
      if (result.length >= limit) {
        truncated = true;
        break;
      }
      // A complete equation is preferable to a short but invalid TeX fragment.
      result += part;
      continue;
    }

    const remaining = limit - result.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (part.length <= remaining) {
      result += part;
      continue;
    }
    const candidate = part.slice(0, remaining);
    const wordBoundary = candidate.search(/\s+\S*$/);
    result += (wordBoundary >= Math.max(12, Math.floor(remaining * 0.55))
      ? candidate.slice(0, wordBoundary)
      : candidate
    ).trimEnd();
    truncated = true;
    break;
  }

  if (!truncated && result.length < text.length) truncated = true;
  return `${result.trim()}${truncated ? "…" : ""}`;
}

export function titleFrom(text: string, fallback = "Untitled thread"): string {
  const cleaned = cleanTitleMarkdown(
    text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/^\s{0,3}(?:#{1,6}|>)\s*/gm, ""),
  )
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return fallback;
  return truncateTitleWithoutBreakingMath(cleaned, 58);
}

function containsMathDelimiter(value: string): boolean {
  return /(?<!\\)\$|\\\(|\\\[/.test(value);
}

function titleComparisonKey(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function recoveredThreadTitle(node: ThreadNode): string {
  const quote = node.anchor?.quote;
  if (!quote || !containsMathDelimiter(quote)) return node.title;
  const recovered = titleFrom(quote, node.title);
  const storedKey = titleComparisonKey(node.title);
  const recoveredKey = titleComparisonKey(recovered);
  const storedTitleMatchesAnchor =
    Boolean(storedKey && recoveredKey) &&
    (
      storedKey === recoveredKey ||
      storedKey.startsWith(recoveredKey) ||
      recoveredKey.startsWith(storedKey)
    );
  const storedTitleHasBareTex =
    /\\[A-Za-z]+/.test(node.title) && !containsMathDelimiter(node.title);
  const storedTitleWasCut = node.title.endsWith("…");
  return storedTitleMatchesAnchor || storedTitleHasBareTex || storedTitleWasCut
    ? recovered
    : node.title;
}

export function makeMessage(role: Message["role"], content: string): Message {
  return { id: newId(), role, content, createdAt: timestamp() };
}
