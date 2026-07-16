import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  MessageSquareText,
  Pencil,
  Sparkles,
  Square,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ChatTree, SelectionDraft, ThreadNode } from "../types";
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
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
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
  }, [node.id]);

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
