import type { Tiktoken } from "js-tiktoken/lite";
import type {
  ChatTree,
  ContextNode,
  HighlightAnchor,
  Message,
} from "../types";
import { resolveAnchorRange, type SourceRange } from "./sourceEditing";
import { messagesForNode, threadPath } from "./tree";

/**
 * Annotation requests get this much source context on each side of the
 * selected passage. The selection itself is always included in full.
 */
export const ANNOTATION_CONTEXT_TOKENS_PER_SIDE = 10_000;

let tokenizerPromise: Promise<Tiktoken> | null = null;

async function tokenizer(): Promise<Tiktoken> {
  tokenizerPromise ??= Promise.all([
    import("js-tiktoken/lite"),
    import("js-tiktoken/ranks/o200k_base"),
  ]).then(([{ Tiktoken }, { default: ranks }]) => new Tiktoken(ranks));
  return tokenizerPromise;
}

function encodeText(encoder: Tiktoken, content: string): number[] {
  // Imported books can legitimately contain strings such as <|endoftext|>
  // while explaining tokenizers. They are document text here, not control
  // tokens, so encode them as ordinary text instead of rejecting the import.
  return encoder.encode(content, [], []);
}

export async function countTextTokens(content: string): Promise<number> {
  if (!content) return 0;
  return encodeText(await tokenizer(), content).length;
}

async function tailWithinTokenBudget(
  content: string,
  tokenBudget: number,
  encoder: Tiktoken,
): Promise<string> {
  if (!content || tokenBudget <= 0) return "";

  // Most technical English is roughly 3–4 characters per token. Starting
  // with six keeps the common path to one encoding pass while still expanding
  // for unusually token-dense input such as CJK text or source code.
  let start = Math.max(0, content.length - tokenBudget * 6);
  let candidate = content.slice(start);
  let tokenCount = encodeText(encoder, candidate).length;
  while (start > 0 && tokenCount < tokenBudget) {
    const width = content.length - start;
    start = Math.max(0, start - Math.max(width, tokenBudget));
    candidate = content.slice(start);
    tokenCount = encodeText(encoder, candidate).length;
  }
  if (tokenCount <= tokenBudget) return candidate;

  // Find the longest suffix that fits. Slicing the original string (instead
  // of decoding a token slice) guarantees that Unicode is never split or
  // replaced at the context boundary.
  let low = start;
  let high = content.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (encodeText(encoder, content.slice(middle)).length > tokenBudget) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return content.slice(low);
}

async function headWithinTokenBudget(
  content: string,
  tokenBudget: number,
  encoder: Tiktoken,
): Promise<string> {
  if (!content || tokenBudget <= 0) return "";

  let end = Math.min(content.length, tokenBudget * 6);
  let candidate = content.slice(0, end);
  let tokenCount = encodeText(encoder, candidate).length;
  while (end < content.length && tokenCount < tokenBudget) {
    end = Math.min(content.length, end + Math.max(end, tokenBudget));
    candidate = content.slice(0, end);
    tokenCount = encodeText(encoder, candidate).length;
  }
  if (tokenCount <= tokenBudget) return candidate;

  let low = 0;
  let high = end;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encodeText(encoder, content.slice(0, middle)).length <= tokenBudget) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return content.slice(0, low);
}

export interface TokenContextWindow {
  before: string;
  selected: string;
  after: string;
  content: string;
  range: SourceRange;
}

export async function tokenContextWindowForRange(
  content: string,
  range: SourceRange,
  tokensPerSide = ANNOTATION_CONTEXT_TOKENS_PER_SIDE,
): Promise<TokenContextWindow> {
  const boundedRange = {
    start: Math.max(0, Math.min(content.length, range.start)),
    end: Math.max(0, Math.min(content.length, range.end)),
  };
  if (boundedRange.end < boundedRange.start) {
    [boundedRange.start, boundedRange.end] = [
      boundedRange.end,
      boundedRange.start,
    ];
  }
  const encoder = await tokenizer();
  const [before, after] = await Promise.all([
    tailWithinTokenBudget(
      content.slice(0, boundedRange.start),
      tokensPerSide,
      encoder,
    ),
    headWithinTokenBudget(
      content.slice(boundedRange.end),
      tokensPerSide,
      encoder,
    ),
  ]);
  const selected = content.slice(boundedRange.start, boundedRange.end);
  return {
    before,
    selected,
    after,
    content: `${before}${selected}${after}`,
    range: boundedRange,
  };
}

export async function tokenContextWindowForAnchor(
  content: string,
  anchor: HighlightAnchor,
  tokensPerSide = ANNOTATION_CONTEXT_TOKENS_PER_SIDE,
): Promise<TokenContextWindow> {
  return tokenContextWindowForRange(
    content,
    resolveAnchorRange(content, anchor),
    tokensPerSide,
  );
}

function usableMessage(message: Message, excluded: Set<string>): boolean {
  return (
    !excluded.has(message.id) &&
    !message.pending &&
    !message.error &&
    Boolean(message.content.trim())
  );
}

/**
 * Builds normal recursive thread context while replacing every source message
 * that opened a branch in the active path with a ±token-budget window around
 * that branch's anchor. This is what prevents a nested PDF elaboration from
 * silently re-attaching the full book at each level.
 */
export async function contextForAnchoredRequest(
  chat: ChatTree,
  nodeId: string,
  excludedMessageIds: string[] = [],
  requestAnchor?: HighlightAnchor,
  tokensPerSide = ANNOTATION_CONTEXT_TOKENS_PER_SIDE,
): Promise<ContextNode[]> {
  const path = threadPath(chat, nodeId);
  const anchors = new Map<string, HighlightAnchor>();
  for (const node of path) {
    if (node.anchor) anchors.set(node.anchor.sourceMessageId, node.anchor);
  }
  if (requestAnchor) {
    anchors.set(requestAnchor.sourceMessageId, requestAnchor);
  }
  const excluded = new Set(excludedMessageIds);

  return Promise.all(
    path.map(async (node) => ({
      title: node.title,
      messages: await Promise.all(
        messagesForNode(node)
          .filter((message) => usableMessage(message, excluded))
          .map(async (message) => {
            const anchor = anchors.get(message.id);
            return {
              role: message.role,
              content: anchor
                ? (await tokenContextWindowForAnchor(
                    message.content,
                    anchor,
                    tokensPerSide,
                  )).content
                : message.content,
            };
          }),
      ),
    })),
  );
}
