import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  Link2,
  LoaderCircle,
  LockKeyhole,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { generationDetails } from "../lib/generation";
import { childThreads, threadPath } from "../lib/tree";
import type { ChatTree, InlineDefinition, SelectionDraft } from "../types";
import { InlineMath, MathBlock } from "./MathText";
import { ThreadView } from "./ThreadView";

interface SharedChatResponse {
  title: string;
  createdAt: string;
  chat: ChatTree;
}

const NOOP = () => undefined;

function initialThreadId(): string | null {
  return new URLSearchParams(window.location.search).get("thread");
}

function SharedBranchTree({
  chat,
  parentId,
  activeId,
  onOpen,
  depth = 0,
}: {
  chat: ChatTree;
  parentId: string;
  activeId: string;
  onOpen: (nodeId: string) => void;
  depth?: number;
}) {
  const children = childThreads(chat, parentId);
  if (!children.length) return null;
  return (
    <ul>
      {children.map((child) => (
        <li key={child.id}>
          <button
            className={child.id === activeId ? "active" : ""}
            type="button"
            style={{ paddingLeft: `${12 + depth * 13}px` }}
            onClick={() => onOpen(child.id)}
          >
            <GitBranch size={12} /> <InlineMath source={child.title} />
          </button>
          <SharedBranchTree
            chat={chat}
            parentId={child.id}
            activeId={activeId}
            onOpen={onOpen}
            depth={depth + 1}
          />
        </li>
      ))}
    </ul>
  );
}

function SharedDefinition({
  definition,
  rect,
  onClose,
}: {
  definition: InlineDefinition;
  rect: SelectionDraft["rect"];
  onClose: () => void;
}) {
  const width = Math.min(420, window.innerWidth - 24);
  const left = Math.min(
    window.innerWidth - width - 12,
    Math.max(12, rect.left + rect.width / 2 - width / 2),
  );
  const top = Math.min(window.innerHeight - 220, Math.max(12, rect.top + rect.height + 10));
  return (
    <div className="definition-popover shared-definition" role="dialog" style={{ left, top, width }}>
      <header>
        <span><BookOpen size={13} /> Definition</span>
        <button type="button" aria-label="Close definition" onClick={onClose}><X size={13} /></button>
      </header>
      <MathBlock source={definition.content} />
      {definition.generation && <footer>{generationDetails(definition.generation)}</footer>}
    </div>
  );
}

export function SharedChatView({ token }: { token: string }) {
  const [share, setShare] = useState<SharedChatResponse | null>(null);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [definition, setDefinition] = useState<{
    value: InlineDefinition;
    rect: SelectionDraft["rect"];
  } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/public/shares/${encodeURIComponent(token)}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        const result = (await response.json().catch(() => ({}))) as SharedChatResponse & { error?: string };
        if (!response.ok) throw new Error(result.error ?? "Shared chat not found");
        return result;
      })
      .then((result) => {
        const requested = initialThreadId();
        setShare(result);
        setActiveNodeId(requested && result.chat.nodes[requested] ? requested : result.chat.rootId);
        document.title = `${result.title} · Shared Locus chat`;
      })
      .catch((reason) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "Could not open this shared chat");
        document.title = "Shared chat unavailable · Locus";
      });
    return () => controller.abort();
  }, [token]);

  const openNode = useCallback((nodeId: string) => {
    setActiveNodeId(nodeId);
    setDefinition(null);
    const url = new URL(window.location.href);
    if (share && nodeId === share.chat.rootId) url.searchParams.delete("thread");
    else url.searchParams.set("thread", nodeId);
    window.history.pushState({ thread: nodeId }, "", url);
  }, [share]);

  useEffect(() => {
    if (!share) return;
    const onPopState = () => {
      const requested = initialThreadId();
      setActiveNodeId(requested && share.chat.nodes[requested] ? requested : share.chat.rootId);
      setDefinition(null);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [share]);

  const node = share && activeNodeId ? share.chat.nodes[activeNodeId] : null;
  const path = useMemo(
    () => share && node ? threadPath(share.chat, node.id) : [],
    [node, share],
  );

  if (error) {
    return (
      <main className="shared-chat-status">
        <div className="brand-mark"><GitBranch size={20} /></div>
        <h1>Shared chat unavailable</h1>
        <p>{error}</p>
      </main>
    );
  }
  if (!share || !node) {
    return (
      <main className="shared-chat-status">
        <LoaderCircle className="spin" size={21} />
        <p>Opening shared chat…</p>
      </main>
    );
  }

  return (
    <div className="shared-chat-shell" data-theme="light">
      <header className="shared-chat-header">
        <div className="shared-chat-brand">
          <div className="brand-mark"><GitBranch size={17} /></div>
          <span>Locus</span>
        </div>
        <div className="shared-chat-heading">
          <small><LockKeyhole size={11} /> Public read-only snapshot</small>
          <h1><InlineMath source={share.title} /></h1>
        </div>
        <time title={new Date(share.createdAt).toLocaleString()}>
          Shared {new Date(share.createdAt).toLocaleDateString()}
        </time>
      </header>
      <div className="shared-chat-layout">
        <aside className="shared-chat-branches">
          <strong><Link2 size={13} /> Contents</strong>
          <button
            className={node.id === share.chat.rootId ? "active" : ""}
            type="button"
            onClick={() => openNode(share.chat.rootId)}
          >
            <BookOpen size={12} /> Main thread
          </button>
          <SharedBranchTree
            chat={share.chat}
            parentId={share.chat.rootId}
            activeId={node.id}
            onOpen={openNode}
          />
        </aside>
        <main className="shared-chat-main">
          <header className="shared-thread-header">
            <div>
              {node.parentId && (
                <button type="button" onClick={() => openNode(node.parentId!)}>
                  <ChevronLeft size={13} /> Parent
                </button>
              )}
              <span>{node.id === share.chat.rootId ? "Main thread" : `Branch · depth ${path.length - 1}`}</span>
            </div>
            <h2><InlineMath source={node.id === share.chat.rootId ? share.title : node.title} /></h2>
            {path.length > 1 && (
              <nav aria-label="Thread path">
                {path.map((item, index) => (
                  <span key={item.id}>
                    {index > 0 && <ChevronRight size={10} />}
                    <button type="button" onClick={() => openNode(item.id)}>
                      {index === 0 ? "Main" : <InlineMath source={item.title} />}
                    </button>
                  </span>
                ))}
              </nav>
            )}
          </header>
          <ThreadView
            readOnly
            chat={share.chat}
            node={node}
            onSelect={NOOP}
            onOpenElaboration={openNode}
            onOpenDefinition={(definitionId, rect) => {
              const value = node.definitions?.find((candidate) => candidate.id === definitionId);
              if (value) setDefinition({ value, rect });
            }}
            onGenerateVisualization={NOOP}
            onFixVisualization={NOOP}
            onCompileVisualization={NOOP}
            onStopVisualization={NOOP}
            onDeleteVisualization={NOOP}
            onSend={NOOP}
            onStop={NOOP}
            onEditMessage={NOOP}
            onRegenerateResponse={NOOP}
            onSwitchMessageRevision={NOOP}
            onSwitchResponseRevision={NOOP}
            provider="openai"
            model=""
            onModelChange={NOOP}
            reasoningEffort="none"
            onReasoningEffortChange={NOOP}
            sendShortcut="enter"
          />
        </main>
      </div>
      {definition && (
        <SharedDefinition
          definition={definition.value}
          rect={definition.rect}
          onClose={() => setDefinition(null)}
        />
      )}
    </div>
  );
}

