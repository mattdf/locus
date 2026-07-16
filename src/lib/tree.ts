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
  if (!groups.length) return node.messages;

  return node.messages.map((message) => {
    const group = groups.find(
      (candidate) =>
        candidate.userMessageId === message.id || candidate.assistantMessageId === message.id,
    );
    if (!group) return message;
    const active =
      group.variants.find((variant) => variant.id === group.activeVariantId) ??
      group.variants[0];
    if (!active) return message;
    if (message.id === group.userMessageId) {
      return {
        ...active.userMessage,
        revisionGroupId: group.userMessageId,
        revisionVariantId: active.id,
      };
    }
    return {
      ...active.assistantMessage,
      revisionGroupId: group.userMessageId,
      revisionVariantId: active.id,
    };
  });
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

export function titleFrom(text: string, fallback = "Untitled thread"): string {
  const cleaned = text
    .replace(/[#*_`$>\[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return fallback;
  return cleaned.length > 58 ? `${cleaned.slice(0, 57).trim()}…` : cleaned;
}

export function makeMessage(role: Message["role"], content: string): Message {
  return { id: newId(), role, content, createdAt: timestamp() };
}
