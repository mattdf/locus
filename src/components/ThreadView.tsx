import { BookOpen, MessageSquareText, Sparkles } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ChatTree, SelectionDraft, ThreadNode } from "../types";
import { childThreads } from "../lib/tree";
import { Composer } from "./Composer";
import { MarkdownMessage } from "./MarkdownMessage";

interface ThreadViewProps {
  chat: ChatTree;
  node: ThreadNode;
  side?: boolean;
  onSelect: (selection: SelectionDraft) => void;
  onOpenElaboration: (childId: string) => void;
  onSend: (message: string) => void;
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
  composerInsertion,
  onComposerInsertionApplied,
}: ThreadViewProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const children = childThreads(chat, node.id);
  const waiting = node.messages.some((message) => message.pending);

  useEffect(() => {
    if (waiting) endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [node.messages.length, waiting]);

  return (
    <div className={`thread-view ${side ? "thread-view--side" : ""}`}>
      <div className="thread-messages">
        {node.messages.map((message) => {
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
              </div>
              {message.pending && !message.content ? (
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
                </>
              )}
            </article>
          );
        })}
        <div ref={endRef} />
      </div>
      <div className="thread-composer-wrap">
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
