import type {
  ChatTree,
  Message,
  MessageRevisionGroup,
  ResponseRevisionGroup,
  ThreadNode,
} from "../types";

function uniqueMessages(messages: Message[]): Message[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

function normalizedNode(node: ThreadNode): ThreadNode {
  if (!node.messageRevisions) return node;

  let changed = false;
  const responseRevisions: Record<string, ResponseRevisionGroup> = {
    ...node.responseRevisions,
  };
  const messageRevisions = Object.fromEntries(
    Object.entries(node.messageRevisions).map(([groupId, group]) => {
      const firstVariantByUserMessage = new Map<string, MessageRevisionGroup["variants"][number]>();
      const variants: MessageRevisionGroup["variants"] = [];
      let activeVariantId = group.activeVariantId;
      let groupChanged = false;

      group.variants.forEach((variant) => {
        const originalVariant = firstVariantByUserMessage.get(variant.userMessage.id);
        if (!originalVariant) {
          firstVariantByUserMessage.set(variant.userMessage.id, variant);
          variants.push(variant);
          return;
        }

        // The first regeneration implementation represented another model
        // response as a duplicate user-message variant. Fold those duplicates
        // into response leaves under their actual user-message parent.
        changed = true;
        groupChanged = true;
        const baseAssistantId = originalVariant.assistantMessage.id;
        const currentResponses = responseRevisions[baseAssistantId];
        const duplicateResponses = responseRevisions[variant.assistantMessage.id];
        const responses = uniqueMessages([
          ...(currentResponses?.responses ?? [originalVariant.assistantMessage]),
          ...(duplicateResponses?.responses ?? [variant.assistantMessage]),
        ]);
        let activeResponseId =
          currentResponses?.activeResponseId ?? originalVariant.assistantMessage.id;
        if (group.activeVariantId === variant.id) {
          activeVariantId = originalVariant.id;
          activeResponseId =
            duplicateResponses?.activeResponseId ?? variant.assistantMessage.id;
        }
        if (!responses.some((response) => response.id === activeResponseId)) {
          activeResponseId = responses[0].id;
        }
        responseRevisions[baseAssistantId] = {
          assistantMessageId: baseAssistantId,
          activeResponseId,
          responses,
        };
        delete responseRevisions[variant.assistantMessage.id];
      });

      if (!variants.some((variant) => variant.id === activeVariantId)) {
        activeVariantId = variants[0]?.id ?? group.activeVariantId;
        changed = true;
        groupChanged = true;
      }
      return [
        groupId,
        groupChanged
          ? { ...group, activeVariantId, variants }
          : group,
      ];
    }),
  );

  if (!changed) return node;
  return {
    ...node,
    messageRevisions,
    responseRevisions:
      Object.keys(responseRevisions).length > 0 ? responseRevisions : undefined,
  };
}

export function normalizeChatRevisions(chat: ChatTree): ChatTree {
  let changed = false;
  const nodes = Object.fromEntries(
    Object.entries(chat.nodes).map(([nodeId, node]) => {
      const normalized = normalizedNode(node);
      if (normalized !== node) changed = true;
      return [nodeId, normalized];
    }),
  );
  return changed ? { ...chat, nodes } : chat;
}
