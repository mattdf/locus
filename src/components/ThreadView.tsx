import {
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  MessageSquareText,
  Pencil,
  Sparkles,
  Square,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ChatTree, GenerationMetrics, SelectionDraft, ThreadNode } from "../types";
import { childThreads, messagesForNode } from "../lib/tree";
import { Composer } from "./Composer";
import { MarkdownMessage } from "./MarkdownMessage";

interface ThreadViewProps {
  chat: ChatTree;
  node: ThreadNode;
  side?: boolean;
  onSelect: (selection: SelectionDraft) => void;
  onOpenElaboration: (childId: string) => void;
  onSend: (message: string) => void;
  onStop: (assistantId: string) => void;
  onEditMessage: (revisionGroupId: string, content: string) => void;
  onSwitchMessageRevision: (revisionGroupId: string, variantId: string) => void;
  composerInsertion?: { id: string; value: string };
  onComposerInsertionApplied?: (id: string) => void;
}

async function writeMarkdownToClipboard(markdown: string): Promise<void> {
  const activeElement =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const fallback = document.createElement("textarea");
  fallback.value = markdown;
  fallback.setAttribute("readonly", "");
  fallback.style.cssText =
    "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.appendChild(fallback);
  fallback.select();
  fallback.setSelectionRange(0, fallback.value.length);
  const copiedSynchronously = document.execCommand("copy");
  fallback.remove();
  activeElement?.focus();
  if (copiedSynchronously) return;

  await navigator.clipboard.writeText(markdown);
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))} ms`;
  if (durationMs < 60_000) {
    const seconds = durationMs / 1_000;
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function generationDetails(generation: GenerationMetrics): string {
  const duration = formatDuration(generation.durationMs);
  if (
    generation.totalTokens === null ||
    generation.inputTokens === null ||
    generation.outputTokens === null ||
    generation.reasoningTokens === null
  ) {
    return `${duration} · token usage unavailable`;
  }
  const format = (value: number) => value.toLocaleString();
  return `${duration} · ${format(generation.totalTokens)} tokens total · ${format(generation.inputTokens)} input · ${format(generation.outputTokens)} generated (including ${format(generation.reasoningTokens)} reasoning)`;
}

export function ThreadView({
  chat,
  node,
  side,
  onSelect,
  onOpenElaboration,
  onSend,
  onStop,
  onEditMessage,
  onSwitchMessageRevision,
  composerInsertion,
  onComposerInsertionApplied,
}: ThreadViewProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const copyResetTimer = useRef<number | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [copyState, setCopyState] = useState<{
    messageId: string;
    status: "copied" | "failed";
  } | null>(null);
  const children = childThreads(chat, node.id);
  const messages = messagesForNode(node);
  const pendingAssistant = messages.find(
    (message) => message.role === "assistant" && message.pending,
  );
  const waiting = Boolean(pendingAssistant);

  useEffect(() => {
    if (waiting) endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [node.messages.length, waiting]);

  useEffect(() => {
    setEditingMessageId(null);
    setEditValue("");
    setCopyState(null);
  }, [node.id]);

  useEffect(
    () => () => {
      if (copyResetTimer.current !== null) {
        window.clearTimeout(copyResetTimer.current);
      }
    },
    [],
  );

  const copyResponse = async (messageId: string, markdown: string) => {
    if (copyResetTimer.current !== null) {
      window.clearTimeout(copyResetTimer.current);
    }
    try {
      await writeMarkdownToClipboard(markdown);
      setCopyState({ messageId, status: "copied" });
    } catch {
      setCopyState({ messageId, status: "failed" });
    }
    copyResetTimer.current = window.setTimeout(() => {
      setCopyState(null);
      copyResetTimer.current = null;
    }, 1800);
  };

  return (
    <div className={`thread-view ${side ? "thread-view--side" : ""}`}>
      <div className="thread-messages">
        {messages.map((message) => {
          const revisionGroupId =
            message.role === "user" ? message.revisionGroupId ?? message.id : null;
          const revisionGroup = revisionGroupId
            ? node.messageRevisions?.[revisionGroupId]
            : undefined;
          const activeRevisionIndex = revisionGroup
            ? Math.max(
                0,
                revisionGroup.variants.findIndex(
                  (variant) => variant.id === revisionGroup.activeVariantId,
                ),
              )
            : 0;
          const messageCopyStatus =
            copyState?.messageId === message.id ? copyState.status : null;
          const linkedAnchors = children
            .filter((child) => child.anchor?.sourceMessageId === message.id)
            .map((child) => ({
              childId: child.id,
              title: child.title,
              anchor: child.anchor!,
            }));
          return (
            <article
              className={`message message--${message.role} ${message.error ? "message--error" : ""}`}
              key={message.id}
            >
              <div className="message__meta">
                <span className="message__author">
                  {message.role === "assistant" ? (
                    <Sparkles size={13} />
                  ) : message.role === "source" ? (
                    <BookOpen size={13} />
                  ) : (
                    <MessageSquareText size={13} />
                  )}
                  <span>
                    {message.role === "assistant"
                      ? "Locus"
                      : message.role === "source"
                        ? "Imported source"
                        : "You"}
                  </span>
                </span>
                {message.role === "user" && revisionGroupId && (
                  <span className="message__controls">
                    {revisionGroup && revisionGroup.variants.length > 1 && (
                      <span className="revision-switcher" aria-label="Message versions">
                        <button
                          type="button"
                          aria-label="Previous message version"
                          disabled={waiting || activeRevisionIndex === 0}
                          onClick={() =>
                            onSwitchMessageRevision(
                              revisionGroupId,
                              revisionGroup.variants[activeRevisionIndex - 1].id,
                            )
                          }
                        >
                          <ChevronLeft size={12} />
                        </button>
                        <span>{activeRevisionIndex + 1} / {revisionGroup.variants.length}</span>
                        <button
                          type="button"
                          aria-label="Next message version"
                          disabled={
                            waiting || activeRevisionIndex === revisionGroup.variants.length - 1
                          }
                          onClick={() =>
                            onSwitchMessageRevision(
                              revisionGroupId,
                              revisionGroup.variants[activeRevisionIndex + 1].id,
                            )
                          }
                        >
                          <ChevronRight size={12} />
                        </button>
                      </span>
                    )}
                    <button
                      className="edit-message-button"
                      type="button"
                      aria-label="Edit message"
                      disabled={waiting}
                      onClick={() => {
                        setEditingMessageId(revisionGroupId);
                        setEditValue(message.content);
                      }}
                    >
                      <Pencil size={11} />
                    </button>
                  </span>
                )}
                {message.role === "assistant" && !message.pending && !message.error && message.content && (
                  <span className="message__controls">
                    <button
                      className={`copy-response-button ${messageCopyStatus ? `copy-response-button--${messageCopyStatus}` : ""}`}
                      type="button"
                      aria-label={
                        messageCopyStatus
                          ? messageCopyStatus === "copied"
                            ? "Response copied as Markdown"
                            : "Copy failed"
                          : "Copy response as Markdown"
                      }
                      onClick={() => void copyResponse(message.id, message.content)}
                    >
                      {messageCopyStatus === "copied" ? (
                        <Check size={11} />
                      ) : (
                        <Copy size={11} />
                      )}
                      <span>
                        {messageCopyStatus
                          ? messageCopyStatus === "copied"
                            ? "Copied"
                            : "Failed"
                          : "Copy"}
                      </span>
                    </button>
                  </span>
                )}
              </div>
              {revisionGroupId && editingMessageId === revisionGroupId ? (
                <div className="message-editor">
                  <textarea
                    autoFocus
                    value={editValue}
                    aria-label="Edit previous message"
                    onChange={(event) => setEditValue(event.target.value)}
                  />
                  <div>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingMessageId(null);
                        setEditValue("");
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      className="message-editor__save"
                      type="button"
                      disabled={!editValue.trim() || editValue.trim() === message.content.trim()}
                      onClick={() => {
                        onEditMessage(revisionGroupId, editValue.trim());
                        setEditingMessageId(null);
                        setEditValue("");
                      }}
                    >
                      Save & regenerate
                    </button>
                  </div>
                </div>
              ) : message.pending && !message.content ? (
                <div className="thinking" aria-label="Locus is thinking">
                  <span />
                  <span />
                  <span />
                  <em>Working through the steps…</em>
                </div>
              ) : (
                <>
                <MarkdownMessage
                  message={message}
                  nodeId={node.id}
                  linkedAnchors={linkedAnchors}
                  onSelect={onSelect}
                  onOpenElaboration={onOpenElaboration}
                />
                  {message.pending && (
                    <div className="streaming-status" aria-label="Locus is responding">
                      <span /> Streaming
                    </div>
                  )}
                  {message.stopped && (
                    <div className="stopped-status"><Square size={9} /> Response stopped</div>
                  )}
                  {message.role === "assistant" && !message.pending && message.generation && (
                    <footer className="generation-details" aria-label="Generation details">
                      <Clock3 size={10} />
                      <span>{generationDetails(message.generation)}</span>
                    </footer>
                  )}
                </>
              )}
            </article>
          );
        })}
        <div ref={endRef} />
      </div>
      <div className="thread-composer-wrap">
        {pendingAssistant && (
          <button
            className="stop-response-button"
            type="button"
            onClick={() => onStop(pendingAssistant.id)}
          >
            <Square size={10} fill="currentColor" /> Stop response
          </button>
        )}
        <Composer
          compact={side}
          disabled={waiting}
          onSend={onSend}
          insertion={composerInsertion}
          onInsertionApplied={onComposerInsertionApplied}
          placeholder={side ? "Continue this line of thought…" : "Ask about this topic…"}
        />
        {!side && (
          <p className="selection-tip">
            Select any passage or equation to quote it here or open a focused elaboration.
          </p>
        )}
      </div>
    </div>
  );
}
