import {
  BookOpenText,
  BrainCircuit,
  ChevronLeft,
  ChevronRight,
  CornerUpRight,
  FileInput,
  GitBranch,
  Menu,
  Maximize2,
  Minimize2,
  Moon,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { Composer } from "./components/Composer";
import { ThreadView } from "./components/ThreadView";
import {
  childThreads,
  contextFor,
  makeMessage,
  newId,
  threadPath,
  timestamp,
  titleFrom,
  treeDepth,
} from "./lib/tree";
import type {
  ChatTree,
  HighlightAnchor,
  Message,
  SelectionDraft,
  ThreadNode,
  WorkspaceState,
} from "./types";
import type { ReasoningEffort } from "./types";

const DEFAULT_STATE: WorkspaceState = {
  version: 1,
  chats: [],
  activeChatId: null,
  settings: {
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
    customInstructions: "",
    focusDrawerWidth: 440,
    theme: "light",
  },
};

const MODEL_OPTIONS = [
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", note: "Frontier" },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", note: "Balanced" },
  { value: "gpt-5.4-mini", label: "GPT-5.4 mini", note: "Fast" },
  { value: "gpt-5.4", label: "GPT-5.4", note: "Deep" },
];

const REASONING_OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
];

interface ApiError {
  error?: string;
}

function BranchTree({
  chat,
  parentId,
  activeNodeId,
  onOpen,
  root = false,
}: {
  chat: ChatTree;
  parentId: string;
  activeNodeId: string | null;
  onOpen: (nodeId: string) => void;
  root?: boolean;
}) {
  const children = childThreads(chat, parentId).sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  if (!children.length) return null;

  return (
    <ul className={`branch-tree ${root ? "branch-tree--root" : ""}`}>
      {children.map((node) => (
        <li key={node.id}>
          <button
            type="button"
            className={node.id === activeNodeId ? "active" : ""}
            aria-label={`Open branch: ${node.title}`}
            onClick={() => onOpen(node.id)}
          >
            <GitBranch size={13} />
            <span>{node.title}</span>
          </button>
          <BranchTree
            chat={chat}
            parentId={node.id}
            activeNodeId={activeNodeId}
            onOpen={onOpen}
          />
        </li>
      ))}
    </ul>
  );
}

async function modelRequest(
  payload: unknown,
  onDelta: (delta: string) => void,
): Promise<string> {
  const response = await fetch("/api/respond", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const data = (await response.json()) as ApiError;
    throw new Error(data.error ?? "The model request failed");
  }
  if (!response.body) throw new Error("The browser could not read the response stream");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let streamError: string | null = null;

  const consumeLine = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as
      | { type: "delta"; delta: string }
      | { type: "done" }
      | { type: "error"; error: string };
    if (event.type === "delta") {
      content += event.delta;
      onDelta(event.delta);
    } else if (event.type === "error") {
      streamError = event.error;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    lines.forEach(consumeLine);
    if (done) break;
  }
  consumeLine(buffer);
  if (streamError) throw new Error(streamError);
  if (!content) throw new Error("The model returned no text");
  return content;
}

function SelectionToolbar({
  selection,
  onElaborate,
  onDismiss,
}: {
  selection: SelectionDraft;
  onElaborate: () => void;
  onDismiss: () => void;
}) {
  const [rect, setRect] = useState(selection.rect);

  useEffect(() => setRect(selection.rect), [selection]);

  useEffect(() => {
    let frameId: number | null = null;
    const syncSelection = () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        const liveSelection = window.getSelection();
        if (!liveSelection || liveSelection.isCollapsed || !liveSelection.rangeCount) {
          onDismiss();
          return;
        }

        const range = liveSelection.getRangeAt(0);
        if (!range.toString().trim()) {
          onDismiss();
          return;
        }

        const bounds = range.getBoundingClientRect();
        if (!bounds.width && !bounds.height) {
          onDismiss();
          return;
        }

        setRect({
          left: bounds.left,
          top: bounds.top,
          width: bounds.width,
          height: bounds.height,
        });
      });
    };

    document.addEventListener("selectionchange", syncSelection);
    document.addEventListener("scroll", syncSelection, true);
    window.addEventListener("resize", syncSelection);
    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      document.removeEventListener("selectionchange", syncSelection);
      document.removeEventListener("scroll", syncSelection, true);
      window.removeEventListener("resize", syncSelection);
    };
  }, [selection.sourceNodeId, selection.sourceMessageId, selection.quote]);

  return (
    <div
      className="selection-toolbar"
      style={{
        left: Math.max(116, Math.min(window.innerWidth - 116, rect.left + rect.width / 2)),
        top: rect.top > 70 ? rect.top - 12 : rect.top + rect.height + 46,
      }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <span>
        “{selection.quote.replace(/\s+/g, " ").trim().slice(0, 42)}
        {selection.quote.trim().length > 42 ? "…" : ""}”
      </span>
      <button type="button" onClick={onElaborate}>
        <CornerUpRight size={14} /> Elaborate
      </button>
      <button
        type="button"
        className="toolbar-close"
        aria-label="Dismiss"
        onClick={() => {
          window.getSelection()?.removeAllRanges();
          onDismiss();
        }}
      >
        <X size={13} />
      </button>
    </div>
  );
}

function NewChatScreen({
  initialMode,
  onCreate,
  onOpenSidebar,
}: {
  initialMode: "ask" | "import";
  onCreate: (mode: "ask" | "import", content: string, title: string) => void;
  onOpenSidebar: () => void;
}) {
  const [mode, setMode] = useState(initialMode);
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");

  useEffect(() => setMode(initialMode), [initialMode]);

  return (
    <main className="new-chat">
      <header className="new-chat__mobile-header">
        <button
          className="menu-button"
          type="button"
          aria-label="Open studies"
          onClick={onOpenSidebar}
        >
          <Menu size={19} />
        </button>
        <strong>Locus</strong>
      </header>
      <div className="new-chat__inner">
        <div className="new-chat__mark">
          <GitBranch size={25} />
        </div>
        <p className="eyebrow">Recursive learning chat</p>
        <h1>Recursive, branchable chat.</h1>
        <p className="new-chat__lede">
          Select any passage or equation to open a child thread. Child threads can branch
          again at any depth.
        </p>

        <section className="start-card">
          <div className="mode-switch" role="tablist" aria-label="New chat mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "ask"}
              className={mode === "ask" ? "active" : ""}
              onClick={() => setMode("ask")}
            >
              <Sparkles size={15} /> Ask Locus
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "import"}
              className={mode === "import" ? "active" : ""}
              onClick={() => setMode("import")}
            >
              <FileInput size={15} /> Import Markdown
            </button>
          </div>
          <input
            className="title-input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Title (optional)"
            aria-label="Chat title"
          />
          <textarea
            autoFocus
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={9}
            placeholder={
              mode === "import"
                ? "Paste Markdown here — nothing is sent to the model.\n\nEquations like $\\nabla_\\theta L$ render automatically."
                : "What are you trying to understand? Include as much context as you like."
            }
            aria-label={mode === "import" ? "Markdown to import" : "Question for Locus"}
          />
          <div className="start-card__footer">
            <span>
              {mode === "import" ? "Saved locally · no model call" : "Uses the selected model"}
            </span>
            <button
              className="primary-button"
              type="button"
              disabled={!content.trim()}
              onClick={() => onCreate(mode, content.trim(), title.trim())}
            >
              {mode === "import" ? "Create from Markdown" : "Start conversation"}
              <ChevronRight size={16} />
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceState>(DEFAULT_STATE);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [selection, setSelection] = useState<SelectionDraft | null>(null);
  const [draft, setDraft] = useState<SelectionDraft | null>(null);
  const [newMode, setNewMode] = useState<"ask" | "import">("ask");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [customInstructionsOpen, setCustomInstructionsOpen] = useState(false);
  const [customInstructionsDraft, setCustomInstructionsDraft] = useState("");
  const [drawerWidth, setDrawerWidth] = useState(440);
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [renamingChat, setRenamingChat] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [focusMaximized, setFocusMaximized] = useState(false);

  const activeChat = workspace.chats.find((chat) => chat.id === workspace.activeChatId) ?? null;
  const rootNode = activeChat ? activeChat.nodes[activeChat.rootId] : null;
  const activeNode =
    activeChat && activeNodeId && activeChat.nodes[activeNodeId]
      ? activeChat.nodes[activeNodeId]
      : rootNode;
  const sideNode = activeNode && rootNode && activeNode.id !== rootNode.id ? activeNode : null;

  useEffect(() => {
    fetch("/api/state")
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load local chats");
        return (await response.json()) as WorkspaceState;
      })
      .then((state) => {
        setWorkspace(state);
        setDrawerWidth(state.settings.focusDrawerWidth ?? 440);
        const chat = state.chats.find((item) => item.id === state.activeChatId);
        setActiveNodeId(chat?.rootId ?? null);
      })
      .catch(() => setWorkspace(DEFAULT_STATE))
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (!loaded) return;
    setSaveState("saving");
    const timeout = window.setTimeout(() => {
      fetch("/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(workspace),
      })
        .then((response) => {
          if (!response.ok) throw new Error("Save failed");
          setSaveState("saved");
        })
        .catch(() => setSaveState("error"));
    }, 350);
    return () => window.clearTimeout(timeout);
  }, [loaded, workspace]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelection(null);
        window.getSelection()?.removeAllRanges();
        setDraft(null);
        setCustomInstructionsOpen(false);
        setChatMenuOpen(false);
        setBranchMenuOpen(false);
        setRenamingChat(false);
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);

  const updateChat = (chatId: string, update: (chat: ChatTree) => ChatTree) => {
    setWorkspace((current) => ({
      ...current,
      chats: current.chats.map((chat) => (chat.id === chatId ? update(chat) : chat)),
    }));
  };

  const finishAssistant = (
    chatId: string,
    nodeId: string,
    assistantId: string,
    content: string,
    error = false,
  ) => {
    updateChat(chatId, (chat) => {
      const node = chat.nodes[nodeId];
      if (!node) return chat;
      const updatedAt = timestamp();
      return {
        ...chat,
        updatedAt,
        nodes: {
          ...chat.nodes,
          [nodeId]: {
            ...node,
            updatedAt,
            messages: node.messages.map((message) =>
              message.id === assistantId
                ? { ...message, content, pending: false, error }
                : message,
            ),
          },
        },
      };
    });
  };

  const appendAssistantDelta = (
    chatId: string,
    nodeId: string,
    assistantId: string,
    delta: string,
  ) => {
    updateChat(chatId, (chat) => {
      const node = chat.nodes[nodeId];
      if (!node) return chat;
      return {
        ...chat,
        nodes: {
          ...chat.nodes,
          [nodeId]: {
            ...node,
            messages: node.messages.map((message) =>
              message.id === assistantId
                ? { ...message, content: `${message.content}${delta}` }
                : message,
            ),
          },
        },
      };
    });
  };

  const askModel = async (
    chat: ChatTree,
    nodeId: string,
    userMessage: Message,
    assistantId: string,
    anchor?: HighlightAnchor,
  ) => {
    try {
      const content = await modelRequest(
        {
          model: workspace.settings.model,
          reasoningEffort: workspace.settings.reasoningEffort,
          customInstructions: workspace.settings.customInstructions,
          context: contextFor(chat, nodeId, [userMessage.id, assistantId]),
          message: userMessage.content,
          anchor,
        },
        (delta) => appendAssistantDelta(chat.id, nodeId, assistantId, delta),
      );
      finishAssistant(chat.id, nodeId, assistantId, content);
    } catch (error) {
      finishAssistant(
        chat.id,
        nodeId,
        assistantId,
        error instanceof Error ? error.message : "The request failed",
        true,
      );
    }
  };

  const createChat = (mode: "ask" | "import", content: string, suppliedTitle: string) => {
    const createdAt = timestamp();
    const rootId = newId();
    const chatId = newId();
    const userMessage = makeMessage(mode === "import" ? "source" : "user", content);
    const assistantMessage: Message | null =
      mode === "ask"
        ? { ...makeMessage("assistant", ""), pending: true }
        : null;
    const title = suppliedTitle || titleFrom(content, "New study");
    const root: ThreadNode = {
      id: rootId,
      parentId: null,
      title,
      messages: assistantMessage ? [userMessage, assistantMessage] : [userMessage],
      createdAt,
      updatedAt: createdAt,
    };
    const chat: ChatTree = {
      id: chatId,
      title,
      rootId,
      nodes: { [rootId]: root },
      createdAt,
      updatedAt: createdAt,
    };
    setWorkspace((current) => ({
      ...current,
      activeChatId: chatId,
      chats: [chat, ...current.chats],
    }));
    setActiveNodeId(rootId);
    setDraft(null);
    if (assistantMessage) void askModel(chat, rootId, userMessage, assistantMessage.id);
  };

  const sendToThread = (nodeId: string, content: string) => {
    if (!activeChat) return;
    const node = activeChat.nodes[nodeId];
    if (!node) return;
    const userMessage = makeMessage("user", content);
    const assistantMessage: Message = { ...makeMessage("assistant", ""), pending: true };
    const updatedAt = timestamp();
    const nextChat: ChatTree = {
      ...activeChat,
      updatedAt,
      nodes: {
        ...activeChat.nodes,
        [nodeId]: {
          ...node,
          updatedAt,
          messages: [...node.messages, userMessage, assistantMessage],
        },
      },
    };
    setWorkspace((current) => ({
      ...current,
      chats: current.chats.map((chat) => (chat.id === nextChat.id ? nextChat : chat)),
    }));
    void askModel(nextChat, nodeId, userMessage, assistantMessage.id, node.anchor);
  };

  const beginElaboration = (request: string) => {
    if (!activeChat || !draft) return;
    const parent = activeChat.nodes[draft.sourceNodeId];
    if (!parent) return;
    const createdAt = timestamp();
    const childId = newId();
    const anchor: HighlightAnchor = {
      sourceNodeId: draft.sourceNodeId,
      sourceMessageId: draft.sourceMessageId,
      quote: draft.quote,
      blockIndex: draft.blockIndex,
    };
    const userMessage = makeMessage("user", request);
    const assistantMessage: Message = { ...makeMessage("assistant", ""), pending: true };
    const child: ThreadNode = {
      id: childId,
      parentId: parent.id,
      title: titleFrom(draft.quote, "Focused elaboration"),
      anchor,
      messages: [userMessage, assistantMessage],
      createdAt,
      updatedAt: createdAt,
    };
    const nextChat: ChatTree = {
      ...activeChat,
      updatedAt: createdAt,
      nodes: { ...activeChat.nodes, [childId]: child },
    };
    setWorkspace((current) => ({
      ...current,
      chats: current.chats.map((chat) => (chat.id === nextChat.id ? nextChat : chat)),
    }));
    setActiveNodeId(childId);
    setDraft(null);
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    void askModel(nextChat, childId, userMessage, assistantMessage.id, anchor);
  };

  const saveDrawerWidth = (width: number) => {
    const nextWidth = Math.min(720, Math.max(320, Math.round(width)));
    setDrawerWidth(nextWidth);
    setWorkspace((current) => ({
      ...current,
      settings: { ...current.settings, focusDrawerWidth: nextWidth },
    }));
  };

  const beginDrawerResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();

    const startX = event.clientX;
    const startWidth =
      event.currentTarget.parentElement?.getBoundingClientRect().width ?? drawerWidth;
    let nextWidth = startWidth;
    document.body.classList.add("resizing-drawer");

    const handleMove = (moveEvent: PointerEvent) => {
      nextWidth = Math.min(720, Math.max(320, startWidth + startX - moveEvent.clientX));
      setDrawerWidth(nextWidth);
    };

    const finishResize = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
      document.body.classList.remove("resizing-drawer");
      saveDrawerWidth(nextWidth);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
  };

  const resizeDrawerWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const currentWidth =
      event.currentTarget.parentElement?.getBoundingClientRect().width ?? drawerWidth;
    saveDrawerWidth(currentWidth + (event.key === "ArrowLeft" ? 24 : -24));
  };

  const openRenameChat = () => {
    if (!activeChat) return;
    setRenameDraft(activeChat.title);
    setRenamingChat(true);
  };

  const saveChatName = () => {
    if (!activeChat) return;
    const title = renameDraft.trim();
    if (!title) return;
    const updatedAt = timestamp();
    updateChat(activeChat.id, (chat) => ({
      ...chat,
      title,
      updatedAt,
      nodes: {
        ...chat.nodes,
        [chat.rootId]: { ...chat.nodes[chat.rootId], title, updatedAt },
      },
    }));
    setRenamingChat(false);
    setChatMenuOpen(false);
  };

  const toggleChatPin = () => {
    if (!activeChat) return;
    updateChat(activeChat.id, (chat) => ({
      ...chat,
      pinned: !chat.pinned,
      updatedAt: timestamp(),
    }));
    setChatMenuOpen(false);
  };

  const deleteActiveChat = () => {
    if (!activeChat || !window.confirm(`Delete “${activeChat.title}”?`)) return;
    setWorkspace((current) => ({
      ...current,
      activeChatId: null,
      chats: current.chats.filter((chat) => chat.id !== activeChat.id),
    }));
    setActiveNodeId(null);
    setDraft(null);
    setSelection(null);
    setChatMenuOpen(false);
    setBranchMenuOpen(false);
    setRenamingChat(false);
    setFocusMaximized(false);
  };

  const filteredChats = useMemo(() => {
    const query = search.trim().toLowerCase();
    return workspace.chats
      .filter((chat) => !query || chat.title.toLowerCase().includes(query))
      .sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)));
  }, [search, workspace.chats]);

  const openChat = (chat: ChatTree) => {
    setWorkspace((current) => ({ ...current, activeChatId: chat.id }));
    setActiveNodeId(chat.rootId);
    setDraft(null);
    setSelection(null);
    setSidebarOpen(false);
    setChatMenuOpen(false);
    setBranchMenuOpen(false);
    setRenamingChat(false);
    setFocusMaximized(false);
  };

  const startNew = (mode: "ask" | "import") => {
    setNewMode(mode);
    setWorkspace((current) => ({ ...current, activeChatId: null }));
    setActiveNodeId(null);
    setDraft(null);
    setSidebarOpen(false);
    setChatMenuOpen(false);
    setBranchMenuOpen(false);
    setRenamingChat(false);
    setFocusMaximized(false);
  };

  if (!loaded) {
    return (
      <div className="loading-screen">
        <div className="brand-mark"><GitBranch size={20} /></div>
        <span>Opening your workspace…</span>
      </div>
    );
  }

  const drawerOpen = Boolean(activeChat && (draft || sideNode));
  const activeBranchCount = activeChat ? Object.keys(activeChat.nodes).length - 1 : 0;
  const activePath = activeChat && sideNode ? threadPath(activeChat, sideNode.id) : [];
  const draftPath = activeChat && draft ? threadPath(activeChat, draft.sourceNodeId) : [];
  const drawerResizeHandle = (
    <div
      className="drawer-resize-handle"
      role="separator"
      aria-label="Resize elaboration sidebar"
      aria-orientation="vertical"
      aria-valuemin={320}
      aria-valuemax={720}
      aria-valuenow={drawerWidth}
      tabIndex={0}
      onPointerDown={beginDrawerResize}
      onKeyDown={resizeDrawerWithKeyboard}
    />
  );

  return (
    <div
      className={`app-shell ${drawerOpen ? "app-shell--drawer" : ""} ${focusMaximized && sideNode ? "app-shell--focus-maximized" : ""}`}
      data-theme={workspace.settings.theme}
      style={{ "--focus-drawer-width": `${drawerWidth}px` } as CSSProperties}
    >
      <aside className={`sidebar ${sidebarOpen ? "sidebar--open" : ""}`}>
        <div className="sidebar__top">
          <div className="brand">
            <div className="brand-mark"><GitBranch size={18} /></div>
            <span>Locus</span>
            <small>LOCAL</small>
          </div>
          <button className="mobile-close" type="button" aria-label="Close menu" onClick={() => setSidebarOpen(false)}>
            <X size={18} />
          </button>
          <button className="new-button" type="button" onClick={() => startNew("ask")}>
            <Plus size={16} /> New study
            <span>⌘ N</span>
          </button>
          <button className="import-button" type="button" onClick={() => startNew("import")}>
            <FileInput size={15} /> Import Markdown
          </button>
          <label className="search-box">
            <Search size={14} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search studies"
            />
          </label>
        </div>

        <div className="chat-list">
          <p className="list-label">Studies</p>
          {filteredChats.length ? (
            filteredChats.map((chat) => {
              const branchCount = Object.keys(chat.nodes).length - 1;
              return (
                <button
                  type="button"
                  className={`chat-row ${chat.id === activeChat?.id ? "active" : ""} ${chat.pinned ? "chat-row--pinned" : ""}`}
                  key={chat.id}
                  onClick={() => openChat(chat)}
                >
                  {chat.pinned ? <Pin size={15} /> : <BookOpenText size={15} />}
                  <span>
                    <strong>{chat.title}</strong>
                    <small>
                      {branchCount ? `${branchCount} elaboration${branchCount === 1 ? "" : "s"}` : "Main thread only"}
                    </small>
                  </span>
                  {branchCount > 0 && <em>{treeDepth(chat)}</em>}
                </button>
              );
            })
          ) : (
            <p className="empty-list">{search ? "No matching studies" : "Your studies will appear here."}</p>
          )}
        </div>

        <div className="sidebar__footer">
          <div className="settings-panel">
            <label className="model-select">
              <Settings2 size={15} />
              <span>
                <small>Model</small>
                <select
                  value={workspace.settings.model}
                  onChange={(event) =>
                    setWorkspace((current) => {
                      const model = event.target.value;
                      const reasoningEffort =
                        current.settings.reasoningEffort === "max" && !model.startsWith("gpt-5.6")
                          ? "xhigh"
                          : current.settings.reasoningEffort;
                      return {
                        ...current,
                        settings: { ...current.settings, model, reasoningEffort },
                      };
                    })
                  }
                >
                  {MODEL_OPTIONS.map((model) => (
                    <option value={model.value} key={model.value}>
                      {model.label} · {model.note}
                    </option>
                  ))}
                </select>
              </span>
            </label>
            <label className="model-select">
              <BrainCircuit size={15} />
              <span>
                <small>Reasoning effort</small>
                <select
                  value={workspace.settings.reasoningEffort}
                  onChange={(event) =>
                    setWorkspace((current) => ({
                      ...current,
                      settings: {
                        ...current.settings,
                        reasoningEffort: event.target.value as ReasoningEffort,
                      },
                    }))
                  }
                >
                  {REASONING_OPTIONS.map((effort) => (
                    <option
                      value={effort.value}
                      key={effort.value}
                      disabled={effort.value === "max" && !workspace.settings.model.startsWith("gpt-5.6")}
                    >
                      {effort.label}
                    </option>
                  ))}
                </select>
              </span>
            </label>
            <button
              className="custom-instructions-button"
              type="button"
              onClick={() => {
                setCustomInstructionsDraft(workspace.settings.customInstructions);
                setCustomInstructionsOpen(true);
              }}
            >
              <SlidersHorizontal size={15} />
              <span>
                <small>Custom instructions</small>
                <strong>
                  {workspace.settings.customInstructions.trim()
                    ? `${workspace.settings.customInstructions.trim().length} characters`
                    : "Not set"}
                </strong>
              </span>
              <ChevronRight size={13} />
            </button>
            <button
              className="theme-toggle-button"
              type="button"
              aria-label={
                workspace.settings.theme === "dark" ? "Use light mode" : "Use dark mode"
              }
              aria-pressed={workspace.settings.theme === "dark"}
              onClick={() =>
                setWorkspace((current) => ({
                  ...current,
                  settings: {
                    ...current.settings,
                    theme: current.settings.theme === "dark" ? "light" : "dark",
                  },
                }))
              }
            >
              {workspace.settings.theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
              <span>
                <small>Appearance</small>
                <strong>{workspace.settings.theme === "dark" ? "Dark mode" : "Light mode"}</strong>
              </span>
              <i className="theme-switch" aria-hidden="true"><span /></i>
            </button>
          </div>
          <div className={`save-status save-status--${saveState}`}>
            <i />
            {saveState === "saved" ? "Saved locally" : saveState === "saving" ? "Saving…" : "Save failed"}
          </div>
        </div>
      </aside>

      {sidebarOpen && <button className="sidebar-scrim" type="button" aria-label="Close menu" onClick={() => setSidebarOpen(false)} />}

      {!activeChat || !rootNode ? (
        <NewChatScreen
          initialMode={newMode}
          onCreate={createChat}
          onOpenSidebar={() => setSidebarOpen(true)}
        />
      ) : (
        <main className="main-pane">
          {(chatMenuOpen || branchMenuOpen) && (
            <button
              className="chat-menu-scrim"
              type="button"
              aria-label="Close header menu"
              onClick={() => {
                setChatMenuOpen(false);
                setBranchMenuOpen(false);
                setRenamingChat(false);
              }}
            />
          )}
          <header className="pane-header">
            <button className="menu-button" type="button" aria-label="Open studies" onClick={() => setSidebarOpen(true)}>
              <Menu size={19} />
            </button>
            <div className="pane-header__title">
              <span>Main thread</span>
              <h1>{activeChat.title}</h1>
            </div>
            <div className="pane-header__actions">
              <div className="header-popover-anchor">
                <button
                  className="branch-stat branch-stat--button"
                  type="button"
                  aria-label="Show branches"
                  aria-haspopup="true"
                  aria-expanded={branchMenuOpen}
                  onClick={() => {
                    setBranchMenuOpen((open) => !open);
                    setChatMenuOpen(false);
                    setRenamingChat(false);
                  }}
                >
                  <GitBranch size={14} /> {activeBranchCount}
                </button>
                {branchMenuOpen && (
                  <section className="branch-menu" aria-label="Branch tree">
                    <header>
                      <span>Branches</span>
                      <strong>{activeBranchCount}</strong>
                    </header>
                    <div className="branch-menu__body">
                      {activeBranchCount ? (
                        <BranchTree
                          chat={activeChat}
                          parentId={activeChat.rootId}
                          activeNodeId={activeNodeId}
                          root
                          onOpen={(nodeId) => {
                            setActiveNodeId(nodeId);
                            setDraft(null);
                            setSelection(null);
                            setFocusMaximized(false);
                            setBranchMenuOpen(false);
                          }}
                        />
                      ) : (
                        <p>No branches yet.</p>
                      )}
                    </div>
                  </section>
                )}
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Chat options"
                aria-haspopup="true"
                aria-expanded={chatMenuOpen}
                onClick={() => {
                  setChatMenuOpen((open) => !open);
                  setBranchMenuOpen(false);
                  setRenamingChat(false);
                }}
              >
                <MoreHorizontal size={17} />
              </button>
              {chatMenuOpen && (
                <div className="chat-menu" aria-label="Chat options">
                  {renamingChat ? (
                    <form
                      className="chat-menu__rename"
                      onSubmit={(event) => {
                        event.preventDefault();
                        saveChatName();
                      }}
                    >
                      <label htmlFor="rename-chat">Chat name</label>
                      <input
                        id="rename-chat"
                        autoFocus
                        value={renameDraft}
                        onChange={(event) => setRenameDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            event.stopPropagation();
                            setRenamingChat(false);
                          }
                        }}
                      />
                      <div>
                        <button type="button" onClick={() => setRenamingChat(false)}>Cancel</button>
                        <button className="chat-menu__save" type="submit" disabled={!renameDraft.trim()}>Save</button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <button type="button" onClick={openRenameChat}>
                        <Pencil size={15} /> Rename chat
                      </button>
                      <button type="button" onClick={toggleChatPin}>
                        <Pin size={15} /> {activeChat.pinned ? "Unpin from top" : "Pin to top"}
                      </button>
                      <div className="chat-menu__divider" />
                      <button className="chat-menu__danger" type="button" onClick={deleteActiveChat}>
                        <Trash2 size={15} /> Delete chat
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </header>
          <ThreadView
            chat={activeChat}
            node={rootNode}
            onSelect={setSelection}
            onOpenElaboration={(id) => {
              setActiveNodeId(id);
              setDraft(null);
              setFocusMaximized(false);
            }}
            onSend={(message) => sendToThread(rootNode.id, message)}
          />
        </main>
      )}

      {activeChat && draft && (
        <aside className="focus-drawer">
          {drawerResizeHandle}
          <header className="focus-header">
            <button
              className="menu-button focus-menu-button"
              type="button"
              aria-label="Open studies"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu size={19} />
            </button>
            <div className="focus-header__title">
              <span className="focus-kicker"><CornerUpRight size={13} /> New elaboration</span>
              <h2>Open a focused thread</h2>
            </div>
            <div className="focus-header__actions">
              <button className="icon-button" type="button" aria-label="Close elaboration" onClick={() => setDraft(null)}>
                <X size={17} />
              </button>
            </div>
          </header>
          <nav className="breadcrumbs" aria-label="Thread path">
            {draftPath.map((node, index) => (
              <span key={node.id}>
                {index > 0 && <ChevronRight size={12} />}
                <button type="button" onClick={() => { setActiveNodeId(node.id); setDraft(null); }}>
                  {index === 0 ? "Main" : node.title}
                </button>
              </span>
            ))}
            <span><ChevronRight size={12} /><strong>New</strong></span>
          </nav>
          <div className="draft-body">
            <div className="quoted-passage">
              <span>Selected passage</span>
              <blockquote>{draft.quote}</blockquote>
            </div>
            <div className="draft-prompt">
              <h3>What should Locus unpack?</h3>
              <p>Your request and the exact selection are sent with the complete path above.</p>
              <Composer
                compact
                initialValue=""
                placeholder="e.g. Show every algebraic step between these two lines…"
                submitLabel="Start elaboration"
                onSend={beginElaboration}
              />
              <div className="prompt-suggestions">
                <button type="button" onClick={() => beginElaboration("Show every missing algebraic step in this passage.")}>Missing algebra</button>
                <button type="button" onClick={() => beginElaboration("Give me an intuitive geometric explanation of this passage.")}>Geometric intuition</button>
                <button type="button" onClick={() => beginElaboration("Work through a small concrete example of this.")}>Concrete example</button>
              </div>
            </div>
          </div>
        </aside>
      )}

      {activeChat && sideNode && !draft && (
        <aside className="focus-drawer">
          {drawerResizeHandle}
          <header className="focus-header">
            <button
              className="menu-button focus-menu-button"
              type="button"
              aria-label="Open studies"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu size={19} />
            </button>
            <div className="focus-header__title">
              <span className="focus-kicker"><GitBranch size={13} /> Focus · depth {activePath.length - 1}</span>
              <h2>{sideNode.title}</h2>
            </div>
            <div className="focus-header__actions">
              <button
                className="icon-button focus-maximize-button"
                type="button"
                title={focusMaximized ? "Restore split view" : "Maximize focused thread"}
                aria-label={focusMaximized ? "Restore split view" : "Maximize focused thread"}
                onClick={() => setFocusMaximized((maximized) => !maximized)}
              >
                {focusMaximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </button>
              <button
                className="icon-button"
                type="button"
                aria-label="Close focused thread"
                onClick={() => {
                  setActiveNodeId(activeChat.rootId);
                  setFocusMaximized(false);
                }}
              >
                <X size={17} />
              </button>
            </div>
          </header>
          <nav className="breadcrumbs" aria-label="Thread path">
            {activePath.map((node, index) => (
              <span key={node.id}>
                {index > 0 && <ChevronRight size={12} />}
                {node.id === sideNode.id ? (
                  <strong>{node.title}</strong>
                ) : (
                  <button type="button" onClick={() => setActiveNodeId(node.id)}>
                    {index === 0 ? "Main" : node.title}
                  </button>
                )}
              </span>
            ))}
          </nav>
          {sideNode.anchor && (
            <div className="focus-quote">
              <span>Elaborating on</span>
              <p>“{sideNode.anchor.quote}”</p>
            </div>
          )}
          <ThreadView
            chat={activeChat}
            node={sideNode}
            side
            onSelect={setSelection}
            onOpenElaboration={(id) => setActiveNodeId(id)}
            onSend={(message) => sendToThread(sideNode.id, message)}
          />
        </aside>
      )}

      {customInstructionsOpen && (
        <div
          className="settings-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setCustomInstructionsOpen(false);
          }}
        >
          <section
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="custom-instructions-title"
          >
            <header>
              <div>
                <span>Behavior</span>
                <h2 id="custom-instructions-title">Custom instructions</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Close custom instructions"
                onClick={() => setCustomInstructionsOpen(false)}
              >
                <X size={17} />
              </button>
            </header>
            <p>
              These are added to Locus’s built-in tutoring instructions for every model call.
              They do not replace the tutoring prompt.
            </p>
            <textarea
              autoFocus
              rows={13}
              value={customInstructionsDraft}
              onChange={(event) => setCustomInstructionsDraft(event.target.value)}
              placeholder="Paste your ChatGPT custom instructions here…"
              aria-label="Custom instructions"
            />
            <footer>
              <span>{customInstructionsDraft.length.toLocaleString()} / 30,000</span>
              <button
                className="secondary-button"
                type="button"
                onClick={() => setCustomInstructionsOpen(false)}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={customInstructionsDraft.length > 30_000}
                onClick={() => {
                  setWorkspace((current) => ({
                    ...current,
                    settings: {
                      ...current.settings,
                      customInstructions: customInstructionsDraft,
                    },
                  }));
                  setCustomInstructionsOpen(false);
                }}
              >
                Save instructions
              </button>
            </footer>
          </section>
        </div>
      )}

      {selection && !draft && (
        <SelectionToolbar
          selection={selection}
          onDismiss={() => setSelection(null)}
          onElaborate={() => {
            setDraft(selection);
            setSelection(null);
            setFocusMaximized(false);
          }}
        />
      )}
    </div>
  );
}
