import type {
  AnnotationKind,
  AnnotationTarget,
  ChatTree,
  GenerationMetrics,
  HighlightAnchor,
  Message,
  ThreadNode,
  WorkspaceState,
} from "../types";
import { markdownBlockRanges } from "./sourceEditing";
import { activeEditContent, messagesForNode } from "./tree";

export type StudySearchKind =
  | "chat"
  | "thread"
  | "message"
  | "definition"
  | "visualization"
  | "inline-elaboration";

export interface StudySearchResult {
  id: string;
  chatId: string;
  nodeId: string;
  kind: StudySearchKind;
  title: string;
  context: string;
  snippet: string;
  anchor?: HighlightAnchor;
  annotation?: AnnotationTarget;
  score: number;
}

export interface AnnotationIntegrityItem {
  id: string;
  chatId: string;
  nodeId: string;
  kind: AnnotationKind;
  target: AnnotationTarget;
  title: string;
  quote: string;
  status: "healthy" | "ambiguous" | "orphaned" | "needs-review";
  reason: string;
  anchor: HighlightAnchor;
  suggestedAnchor?: HighlightAnchor;
}

export type WorkspaceJobKind =
  | "response"
  | "definition"
  | "visualization"
  | "inline-elaboration"
  | "pdf";
export type WorkspaceJobStatus =
  | "draft"
  | "running"
  | "completed"
  | "failed"
  | "stopped";

export interface WorkspaceJob {
  id: string;
  kind: WorkspaceJobKind;
  status: WorkspaceJobStatus;
  chatId: string;
  nodeId: string;
  subjectId: string;
  title: string;
  detail: string;
  error?: string;
  compilerLog?: string;
  requestId?: string;
  createdAt: string;
  updatedAt: string;
  generation?: GenerationMetrics;
  anchor?: HighlightAnchor;
  annotation?: AnnotationTarget;
}

function compactPlainText(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/^```[^\n]*\n?|```$/g, ""))
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*])\s+/gm, "")
    .replace(/[*_~`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function snippetAround(source: string, index: number, length: number): string {
  const compact = source.replace(/\s+/g, " ").trim();
  if (compact.length <= 180) return compact;
  const originalPrefix = source.slice(0, Math.max(0, index)).replace(/\s+/g, " ").length;
  const start = Math.max(0, originalPrefix - 70);
  const end = Math.min(compact.length, originalPrefix + Math.max(length, 30) + 90);
  return `${start ? "…" : ""}${compact.slice(start, end).trim()}${end < compact.length ? "…" : ""}`;
}

function blockIndexAt(source: string, offset: number): number {
  const blocks = markdownBlockRanges(source);
  const containing = blocks.findIndex(
    (block) => offset >= block.start && offset <= block.end,
  );
  if (containing >= 0) return containing;
  const following = blocks.findIndex((block) => block.start > offset);
  return following < 0 ? Math.max(0, blocks.length - 1) : Math.max(0, following - 1);
}

function anchorForMatch(
  nodeId: string,
  messageId: string,
  source: string,
  index: number,
  length: number,
): HighlightAnchor {
  const start = Math.max(0, index);
  const end = Math.min(source.length, start + Math.max(1, length));
  return {
    sourceNodeId: nodeId,
    sourceMessageId: messageId,
    quote: source.slice(start, end),
    blockIndex: blockIndexAt(source, start),
    start,
    end,
    prefix: source.slice(Math.max(0, start - 64), start),
    suffix: source.slice(end, Math.min(source.length, end + 64)),
    status: "resolved",
  };
}

function searchField(
  query: string,
  raw: string,
): { index: number; length: number; score: number } | null {
  const lowered = raw.toLocaleLowerCase();
  const index = lowered.indexOf(query);
  if (index >= 0) {
    const wordBoundary =
      (index === 0 || /\W/.test(lowered[index - 1])) &&
      (index + query.length === lowered.length || /\W/.test(lowered[index + query.length]));
    return { index, length: query.length, score: wordBoundary ? 8 : 6 };
  }
  const plain = compactPlainText(raw).toLocaleLowerCase();
  const plainIndex = plain.indexOf(query);
  return plainIndex >= 0 ? { index: 0, length: query.length, score: 4 } : null;
}

export function searchWorkspace(
  workspace: WorkspaceState,
  rawQuery: string,
  limit = 80,
): StudySearchResult[] {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return [];
  const results: StudySearchResult[] = [];

  const push = (result: StudySearchResult) => {
    results.push(result);
  };

  workspace.chats.forEach((chat) => {
    const chatMatch = searchField(query, chat.title);
    if (chatMatch) {
      push({
        id: `chat:${chat.id}`,
        chatId: chat.id,
        nodeId: chat.rootId,
        kind: "chat",
        title: chat.title,
        context: "Study title",
        snippet: chat.title,
        score: chatMatch.score + 8 + Number(Boolean(chat.pinned)),
      });
    }

    Object.values(chat.nodes).forEach((node) => {
      if (node.id !== chat.rootId) {
        const threadMatch = searchField(query, node.title);
        if (threadMatch) {
          push({
            id: `thread:${chat.id}:${node.id}`,
            chatId: chat.id,
            nodeId: node.id,
            kind: "thread",
            title: node.title,
            context: chat.title,
            snippet: node.anchor?.quote
              ? compactPlainText(node.anchor.quote).slice(0, 180)
              : "Elaboration thread",
            score: threadMatch.score + 6,
          });
        }
      }

      messagesForNode(node).forEach((message) => {
        const match = searchField(query, message.content);
        if (!match) return;
        push({
          id: `message:${chat.id}:${node.id}:${message.id}`,
          chatId: chat.id,
          nodeId: node.id,
          kind: "message",
          title: node.id === chat.rootId ? chat.title : node.title,
          context:
            message.role === "assistant"
              ? "Model response"
              : message.role === "source"
                ? "Imported source"
                : "Your message",
          snippet: snippetAround(message.content, match.index, match.length),
          anchor: anchorForMatch(
            node.id,
            message.id,
            message.content,
            match.index,
            match.length,
          ),
          score: match.score + (message.role === "source" ? 1 : 0),
        });
      });

      (node.definitions ?? []).forEach((definition) => {
        const searchable = `${definition.content}\n${definition.hint ?? ""}`;
        const match = searchField(query, searchable);
        if (!match) return;
        push({
          id: `definition:${chat.id}:${node.id}:${definition.id}`,
          chatId: chat.id,
          nodeId: node.id,
          kind: "definition",
          title: compactPlainText(definition.anchor.quote).slice(0, 90) || "Definition",
          context: `Definition · ${node.title}`,
          snippet: snippetAround(searchable, match.index, match.length),
          anchor: definition.anchor,
          annotation: { kind: "definition", id: definition.id },
          score: match.score + 3,
        });
      });

      (node.visualizations ?? []).forEach((visualization) => {
        const searchable = [
          visualization.hint,
          visualization.errorMessage,
          visualization.source,
          visualization.metapostSource,
        ]
          .filter(Boolean)
          .join("\n");
        const match = searchField(query, searchable);
        if (!match) return;
        push({
          id: `visualization:${chat.id}:${node.id}:${visualization.id}`,
          chatId: chat.id,
          nodeId: node.id,
          kind: "visualization",
          title:
            compactPlainText(visualization.anchor.quote).slice(0, 90) || "Visualization",
          context: `Visualization · ${node.title}`,
          snippet:
            snippetAround(searchable, match.index, match.length) ||
            compactPlainText(visualization.anchor.quote),
          anchor: visualization.anchor,
          annotation: { kind: "visualization", id: visualization.id },
          score: match.score + 2,
        });
      });

      (node.inlineElaborations ?? []).forEach((elaboration) => {
        const searchable = `${elaboration.content}\n${elaboration.hint}`;
        const match = searchField(query, searchable);
        if (!match) return;
        push({
          id: `inline:${chat.id}:${node.id}:${elaboration.id}`,
          chatId: chat.id,
          nodeId: node.id,
          kind: "inline-elaboration",
          title:
            compactPlainText(elaboration.anchor.quote).slice(0, 90) ||
            "Inline elaboration",
          context: `Inline elaboration · ${node.title}`,
          snippet: snippetAround(searchable, match.index, match.length),
          anchor: elaboration.anchor,
          annotation: { kind: "inline-elaboration", id: elaboration.id },
          score: match.score + 2,
        });
      });
    });
  });

  return results
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.title.localeCompare(right.title) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, limit);
}

function sourceContent(node: ThreadNode, sourceMessageId: string): string | null {
  const message = messagesForNode(node).find((item) => item.id === sourceMessageId);
  if (message) return message.content;
  const elaboration = node.inlineElaborations?.find(
    (item) => item.id === sourceMessageId,
  );
  return elaboration
    ? activeEditContent(node, elaboration.id, elaboration.content)
    : null;
}

function occurrenceIndices(source: string, quote: string): number[] {
  const indices: number[] = [];
  if (!quote) return indices;
  let index = source.indexOf(quote);
  while (index >= 0 && indices.length < 100) {
    indices.push(index);
    index = source.indexOf(quote, index + Math.max(1, quote.length));
  }
  return indices;
}

function inspectAnchor(
  chat: ChatTree,
  node: ThreadNode,
  target: AnnotationTarget,
  title: string,
  anchor: HighlightAnchor,
): AnnotationIntegrityItem {
  const source = sourceContent(node, anchor.sourceMessageId);
  const base = {
    id: `${target.kind}:${node.id}:${target.id}`,
    chatId: chat.id,
    nodeId: node.id,
    kind: target.kind,
    target,
    title,
    quote: anchor.quote,
    anchor,
  };
  if (!source) {
    return {
      ...base,
      status: "orphaned",
      reason: "The source message no longer exists in this thread.",
    };
  }

  const quote = anchor.quote.trim();
  const occurrences = occurrenceIndices(source, quote);
  const storedRangeValid =
    Number.isSafeInteger(anchor.start) &&
    Number.isSafeInteger(anchor.end) &&
    anchor.start! >= 0 &&
    anchor.end! >= anchor.start! &&
    anchor.end! <= source.length;
  const storedText = storedRangeValid ? source.slice(anchor.start!, anchor.end!) : "";
  const storedMatches =
    Boolean(quote) &&
    (storedText === quote ||
      storedText.includes(quote) ||
      compactPlainText(storedText) === compactPlainText(quote));

  if (anchor.status === "needs-review") {
    const unique = occurrences.length === 1 ? occurrences[0] : null;
    return {
      ...base,
      status: "needs-review",
      reason:
        unique === null
          ? "A previous edit marked this anchor for manual review."
          : "A previous edit marked this anchor for review, but it now has one exact match.",
      suggestedAnchor:
        unique === null
          ? undefined
          : anchorForMatch(node.id, anchor.sourceMessageId, source, unique, quote.length),
    };
  }

  if (storedMatches) {
    return {
      ...base,
      status: occurrences.length > 1 && !anchor.prefix && !anchor.suffix
        ? "ambiguous"
        : "healthy",
      reason:
        occurrences.length > 1 && !anchor.prefix && !anchor.suffix
          ? `The selected text appears ${occurrences.length} times without enough saved context.`
          : "The stored source range still resolves to the selected passage.",
    };
  }

  if (occurrences.length === 1) {
    return {
      ...base,
      status: "needs-review",
      reason: "The saved offsets drifted, but the passage has one exact match.",
      suggestedAnchor: anchorForMatch(
        node.id,
        anchor.sourceMessageId,
        source,
        occurrences[0],
        quote.length,
      ),
    };
  }
  if (occurrences.length > 1) {
    return {
      ...base,
      status: "ambiguous",
      reason: `The selected text now appears ${occurrences.length} times.`,
    };
  }
  return {
    ...base,
    status: "orphaned",
    reason: "The selected passage can no longer be found in its source message.",
  };
}

export function annotationIntegrity(chat: ChatTree): AnnotationIntegrityItem[] {
  const items: AnnotationIntegrityItem[] = [];
  Object.values(chat.nodes).forEach((node) => {
    Object.values(chat.nodes)
      .filter((candidate) => candidate.parentId === node.id && candidate.anchor)
      .forEach((branch) => {
        items.push(
          inspectAnchor(
            chat,
            node,
            { kind: "branch", id: branch.id },
            branch.title,
            branch.anchor!,
          ),
        );
      });
    (node.definitions ?? []).forEach((definition) => {
      items.push(
        inspectAnchor(
          chat,
          node,
          { kind: "definition", id: definition.id },
          "Definition",
          definition.anchor,
        ),
      );
    });
    (node.visualizations ?? []).forEach((visualization) => {
      items.push(
        inspectAnchor(
          chat,
          node,
          { kind: "visualization", id: visualization.id },
          "Visualization",
          visualization.anchor,
        ),
      );
    });
    (node.inlineElaborations ?? []).forEach((elaboration) => {
      items.push(
        inspectAnchor(
          chat,
          node,
          { kind: "inline-elaboration", id: elaboration.id },
          "Inline elaboration",
          elaboration.anchor,
        ),
      );
    });
  });
  return items.sort((left, right) => {
    const rank = { orphaned: 0, ambiguous: 1, "needs-review": 2, healthy: 3 };
    return rank[left.status] - rank[right.status] || left.title.localeCompare(right.title);
  });
}

function assistantJob(
  chat: ChatTree,
  node: ThreadNode,
  message: Message,
): WorkspaceJob {
  const status: WorkspaceJobStatus = message.pending
    ? "running"
    : message.error
      ? "failed"
      : message.stopped
        ? "stopped"
        : "completed";
  return {
    id: `response:${chat.id}:${node.id}:${message.id}`,
    kind: "response",
    status,
    chatId: chat.id,
    nodeId: node.id,
    subjectId: message.id,
    title: node.id === chat.rootId ? chat.title : node.title,
    detail: "Model response",
    error: message.error ? message.content : undefined,
    requestId: message.requestId,
    createdAt: message.createdAt,
    updatedAt: message.createdAt,
    generation: message.generation,
    anchor: message.content
      ? anchorForMatch(
          node.id,
          message.id,
          message.content,
          0,
          Math.min(80, message.content.length),
        )
      : undefined,
  };
}

export function workspaceJobs(workspace: WorkspaceState): WorkspaceJob[] {
  const jobs: WorkspaceJob[] = [];
  workspace.chats.forEach((chat) => {
    Object.values(chat.nodes).forEach((node) => {
      messagesForNode(node)
        .filter((message) => message.role === "assistant")
        .forEach((message) => jobs.push(assistantJob(chat, node, message)));
      (node.definitions ?? [])
        .filter((definition) => !definition.draft)
        .forEach((definition) => {
          jobs.push({
            id: `definition:${chat.id}:${node.id}:${definition.id}`,
            kind: "definition",
            status: definition.pending
              ? "running"
              : definition.error
                ? "failed"
                : "completed",
            chatId: chat.id,
            nodeId: node.id,
            subjectId: definition.id,
            title: compactPlainText(definition.anchor.quote).slice(0, 90) || "Definition",
            detail: `Definition · ${node.title}`,
            error: definition.error ? definition.content : undefined,
            requestId: definition.requestId,
            createdAt: definition.createdAt,
            updatedAt: definition.createdAt,
            generation: definition.generation,
            anchor: definition.anchor,
            annotation: { kind: "definition", id: definition.id },
          });
        });
      (node.visualizations ?? [])
        .filter((visualization) => visualization.status !== "draft")
        .forEach((visualization) => {
          jobs.push({
            id: `visualization:${chat.id}:${node.id}:${visualization.id}`,
            kind: "visualization",
            status:
              visualization.status === "generating" ||
              visualization.status === "compiling"
                ? "running"
                : visualization.status === "ready"
                  ? "completed"
                  : "failed",
            chatId: chat.id,
            nodeId: node.id,
            subjectId: visualization.id,
            title:
              compactPlainText(visualization.anchor.quote).slice(0, 90) ||
              "Visualization",
            detail: `${visualization.engine === "tikz" ? "TikZ" : "MetaPost"} visualization · ${node.title}`,
            error: visualization.errorMessage,
            compilerLog: visualization.compilerLog,
            requestId: visualization.requestId,
            createdAt: visualization.createdAt,
            updatedAt: visualization.updatedAt,
            generation: visualization.generation,
            anchor: visualization.anchor,
            annotation: { kind: "visualization", id: visualization.id },
          });
        });
      (node.inlineElaborations ?? []).forEach((elaboration) => {
        jobs.push({
          id: `inline:${chat.id}:${node.id}:${elaboration.id}`,
          kind: "inline-elaboration",
          status: elaboration.pending
            ? "running"
            : elaboration.error
              ? "failed"
              : "completed",
          chatId: chat.id,
          nodeId: node.id,
          subjectId: elaboration.id,
          title:
            compactPlainText(elaboration.anchor.quote).slice(0, 90) ||
            "Inline elaboration",
          detail: `Inline elaboration · ${node.title}`,
          error: elaboration.error ? elaboration.content : undefined,
          requestId: elaboration.requestId,
          createdAt: elaboration.createdAt,
          updatedAt: elaboration.updatedAt,
          generation: elaboration.generation,
          anchor: elaboration.anchor,
          annotation: { kind: "inline-elaboration", id: elaboration.id },
        });
      });
    });
    if (chat.source?.kind === "pdf") {
      jobs.push({
        id: `pdf:${chat.id}:${chat.source.jobId}`,
        kind: "pdf",
        status:
          chat.source.status === "importing"
            ? "running"
            : chat.source.status === "ready"
              ? "completed"
              : "failed",
        chatId: chat.id,
        nodeId: chat.rootId,
        subjectId: chat.source.jobId,
        title: chat.source.filename,
        detail: `${chat.source.processedPageCount ?? chat.source.pageCount} PDF pages`,
        error: chat.source.error,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
      });
    }
  });
  return jobs.sort(
    (left, right) =>
      Number(right.status === "running") - Number(left.status === "running") ||
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
}
