import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  BookOpenText,
  ChartNoAxesCombined,
  ChevronLeft,
  ChevronRight,
  CornerDownLeft,
  CornerUpRight,
  Download,
  FileInput,
  Folder,
  FolderInput,
  GitBranch,
  Hash,
  KeyRound,
  Link2,
  LoaderCircle,
  LogOut,
  Menu,
  Maximize2,
  Minimize2,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Pin,
  Plus,
  Quote,
  Search,
  Share2,
  ServerCog,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { Composer } from "./components/Composer";
import { AdminAccountsModal } from "./components/AdminAccountsModal";
import {
  ShareCreatedModal,
  SharedChatsModal,
  type SharedChatSummary,
} from "./components/SharedChatsModal";
import { InlineMath, MathBlock } from "./components/MathText";
import { MODEL_OPTIONS, ModelPicker, REASONING_OPTIONS } from "./components/ModelPicker";
import { ThreadView } from "./components/ThreadView";
import {
  cloneChatForImport,
  downloadChatExport,
  makeChatExport,
  parseChatImport,
  type ParsedChatImport,
} from "./lib/chatTransfer";
import { markdownBlockquote } from "./lib/markdown";
import { generationDetails } from "./lib/generation";
import { applyMarkdownShortcut, isSendShortcut } from "./lib/textarea";
import {
  visualizationEngine,
  visualizationEngineLabel,
  visualizationSource,
} from "./lib/visualization";
import {
  childThreads,
  contextBeforeMessage,
  contextFor,
  makeMessage,
  messagesForNode,
  newId,
  threadPath,
  timestamp,
  titleFrom,
  treeDepth,
} from "./lib/tree";
import type {
  ChatCategory,
  ChatTree,
  GenerationMetrics,
  HighlightAnchor,
  InlineDefinition,
  InlineVisualization,
  Message,
  MessageRevisionGroup,
  ResponseRevisionGroup,
  ProviderId,
  ProviderModelOption,
  ReasoningEffort,
  SelectionDraft,
  ThreadNode,
  VisualizationEngine,
  WorkspaceState,
} from "./types";
import {
  DEFAULT_DEFINITION_MODELS,
  DEFAULT_LOCAL_BASE_URL,
  DEFAULT_PROVIDER_MODELS,
  DEFAULT_VISUALIZATION_MODELS,
  PROVIDER_OPTIONS,
  compatibleReasoningEffort,
  providerLabel,
} from "./lib/providers";
import type { RuntimeInfo } from "./runtime";

const UNCATEGORIZED_CATEGORY_ID = "__uncategorized__";

const DEFAULT_STATE: WorkspaceState = {
  version: 1,
  categories: [],
  chats: [],
  activeChatId: null,
  settings: {
    provider: "openai",
    providerModels: { ...DEFAULT_PROVIDER_MODELS },
    definitionModels: { ...DEFAULT_DEFINITION_MODELS },
    visualizationModels: { ...DEFAULT_VISUALIZATION_MODELS },
    visualizationReasoningEfforts: { openai: "high", openrouter: "high", local: "medium" },
    localBaseUrl: DEFAULT_LOCAL_BASE_URL,
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
    maxOutputTokens: 50_000,
    customInstructions: "",
    focusDrawerWidth: 440,
    sidebarCollapsed: false,
    collapsedCategoryIds: [],
    theme: "light",
    textScale: 100,
    sendShortcut: "enter",
  },
};

interface ApiError {
  error?: string;
}

interface ProviderCredentialStatus {
  configured: boolean;
  required: boolean;
  source: "saved" | "project-file" | null;
}

type ProviderStatuses = Record<ProviderId, ProviderCredentialStatus>;

interface GenerationResult {
  content: string;
  stopped: boolean;
  generation: GenerationMetrics;
}

interface VisualizationCompileResult {
  svg: string;
  log: string;
  durationMs: number;
}

type VisualizationFollowup =
  | { kind: "repair"; source: string; diagnostic: string }
  | { kind: "revision"; source: string; instruction: string };

class VisualizationCompileError extends Error {
  constructor(message: string, readonly log = "") {
    super(message);
  }
}

class GenerationStreamError extends Error {
  constructor(message: string, readonly generation: GenerationMetrics) {
    super(message);
  }
}

interface PendingGeneration {
  kind: "message" | "definition" | "visualization";
  chatId: string;
  nodeId: string;
  assistantId: string;
  requestId: string;
}

interface ViewLocation {
  chatId: string | null;
  nodeId: string | null;
  maximized: boolean;
}

interface ThreadScrollRequest {
  id: string;
  nodeId: string;
  anchor: HighlightAnchor;
}

interface HostedWorkspaceResponse {
  state: WorkspaceState;
  revision: number;
}

interface HostedWorkspaceSync {
  baseRevision: number;
  settings?: WorkspaceState["settings"];
  categories?: ChatCategory[];
  upsertChats?: ChatTree[];
  deleteChatIds?: string[];
  activeChatId?: string | null;
}

function workspaceSyncChanges(
  before: WorkspaceState,
  after: WorkspaceState,
  baseRevision: number,
): HostedWorkspaceSync | null {
  const changes: HostedWorkspaceSync = { baseRevision };
  if (JSON.stringify(before.settings) !== JSON.stringify(after.settings)) {
    changes.settings = after.settings;
  }
  if (JSON.stringify(before.categories) !== JSON.stringify(after.categories)) {
    changes.categories = after.categories;
  }
  const previousChats = new Map(before.chats.map((chat) => [chat.id, chat]));
  const nextChatIds = new Set(after.chats.map((chat) => chat.id));
  const upsertChats = after.chats.filter(
    (chat) => JSON.stringify(previousChats.get(chat.id)) !== JSON.stringify(chat),
  );
  const deleteChatIds = before.chats
    .filter((chat) => !nextChatIds.has(chat.id))
    .map((chat) => chat.id);
  if (upsertChats.length) changes.upsertChats = upsertChats;
  if (deleteChatIds.length) changes.deleteChatIds = deleteChatIds;
  if (before.activeChatId !== after.activeChatId) changes.activeChatId = after.activeChatId;
  return Object.keys(changes).length === 1 ? null : changes;
}

function readViewLocation(): ViewLocation {
  const params = new URLSearchParams(window.location.search);
  return {
    chatId: params.get("chat"),
    nodeId: params.get("thread"),
    maximized: params.get("view") === "focus",
  };
}

function viewUrl(chat: ChatTree | null, nodeId: string | null, maximized: boolean): string {
  const params = new URLSearchParams();
  if (chat) {
    params.set("chat", chat.id);
    if (nodeId && nodeId !== chat.rootId && chat.nodes[nodeId]) {
      params.set("thread", nodeId);
      if (maximized) params.set("view", "focus");
    }
  }
  const query = params.toString();
  return `${window.location.pathname}${query ? `?${query}` : ""}`;
}

function assistantMessageById(node: ThreadNode, assistantId: string): Message | undefined {
  const direct = node.messages.find((message) => message.id === assistantId);
  if (direct) return direct;
  for (const group of Object.values(node.messageRevisions ?? {})) {
    const variant = group.variants.find(
      (candidate) => candidate.assistantMessage.id === assistantId,
    );
    if (variant) return variant.assistantMessage;
  }
  for (const group of Object.values(node.responseRevisions ?? {})) {
    const response = group.responses.find((candidate) => candidate.id === assistantId);
    if (response) return response;
  }
  return undefined;
}

function pendingGenerations(workspace: WorkspaceState): PendingGeneration[] {
  const pending = new Map<string, PendingGeneration>();
  workspace.chats.forEach((chat) => {
    Object.values(chat.nodes).forEach((node) => {
      const messages = [
        ...node.messages,
        ...Object.values(node.messageRevisions ?? {}).flatMap((group) =>
          group.variants.map((variant) => variant.assistantMessage),
        ),
        ...Object.values(node.responseRevisions ?? {}).flatMap((group) =>
          group.responses,
        ),
      ];
      messages.forEach((message) => {
        if (message.role !== "assistant" || !message.pending || !message.requestId) return;
        pending.set(message.id, {
          kind: "message",
          chatId: chat.id,
          nodeId: node.id,
          assistantId: message.id,
          requestId: message.requestId,
        });
      });
      (node.definitions ?? []).forEach((definition) => {
        if (!definition.pending || !definition.requestId) return;
        pending.set(`definition:${definition.id}`, {
          kind: "definition",
          chatId: chat.id,
          nodeId: node.id,
          assistantId: definition.id,
          requestId: definition.requestId,
        });
      });
      (node.visualizations ?? []).forEach((visualization) => {
        if (visualization.status !== "generating" || !visualization.requestId) return;
        pending.set(`visualization:${visualization.id}`, {
          kind: "visualization",
          chatId: chat.id,
          nodeId: node.id,
          assistantId: visualization.id,
          requestId: visualization.requestId,
        });
      });
    });
  });
  return [...pending.values()];
}

function makePendingAssistant(): Message & { requestId: string } {
  return {
    ...makeMessage("assistant", ""),
    pending: true,
    requestId: newId(),
  };
}

function branchSubtreeIds(chat: ChatTree, nodeId: string): string[] {
  const childrenByParent = new Map<string, string[]>();
  Object.values(chat.nodes).forEach((node) => {
    if (!node.parentId) return;
    const siblings = childrenByParent.get(node.parentId) ?? [];
    siblings.push(node.id);
    childrenByParent.set(node.parentId, siblings);
  });

  const subtree: string[] = [];
  const pending = [nodeId];
  const seen = new Set<string>();
  while (pending.length) {
    const currentId = pending.pop();
    if (!currentId || seen.has(currentId) || !chat.nodes[currentId]) continue;
    seen.add(currentId);
    subtree.push(currentId);
    pending.push(...(childrenByParent.get(currentId) ?? []));
  }
  return subtree;
}

function oneParagraph(content: string): string {
  const firstBlock = content.trim().split(/\n\s*\n/, 1)[0] ?? "";
  return firstBlock
    .replace(/^\s{0,3}(?:#{1,6}|[-*+])\s+/, "")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

function BranchTree({
  chat,
  parentId,
  activeNodeId,
  onOpen,
  onRename,
  onDelete,
  root = false,
}: {
  chat: ChatTree;
  parentId: string;
  activeNodeId: string | null;
  onOpen: (nodeId: string) => void;
  onRename: (nodeId: string) => void;
  onDelete: (nodeId: string) => void;
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
          <div className="branch-tree__row">
            <button
              type="button"
              className={`branch-tree__open ${node.id === activeNodeId ? "active" : ""}`}
              aria-label={`Open branch: ${node.title}`}
              onClick={() => onOpen(node.id)}
            >
              <GitBranch size={13} />
              <InlineMath source={node.title} />
            </button>
            <button
              className="branch-tree__rename"
              type="button"
              aria-label={`Rename branch: ${node.title}`}
              onClick={() => onRename(node.id)}
            >
              <Pencil size={11} />
            </button>
            <button
              className="branch-tree__delete"
              type="button"
              aria-label={`Delete branch: ${node.title}`}
              onClick={() => onDelete(node.id)}
            >
              <Trash2 size={11} />
            </button>
          </div>
          <BranchTree
            chat={chat}
            parentId={node.id}
            activeNodeId={activeNodeId}
            onOpen={onOpen}
            onRename={onRename}
            onDelete={onDelete}
          />
        </li>
      ))}
    </ul>
  );
}

async function readGenerationStream(
  response: Response,
  onDelta: (delta: string) => void,
  onSnapshot: (content: string) => void,
): Promise<GenerationResult> {
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as ApiError;
    throw new Error(data.error ?? "The model request failed");
  }
  if (!response.body) throw new Error("The browser could not read the response stream");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let streamError: string | null = null;
  let streamErrorGeneration: GenerationMetrics | null = null;
  let generation: GenerationMetrics | null = null;
  let terminal = false;
  let stopped = false;

  const consumeLine = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as
      | { type: "snapshot"; content: string }
      | { type: "delta"; delta: string }
      | { type: "done"; generation: GenerationMetrics }
      | { type: "stopped"; generation: GenerationMetrics }
      | { type: "error"; error: string; generation: GenerationMetrics };
    if (event.type === "snapshot") {
      content = event.content;
      onSnapshot(content);
    } else if (event.type === "delta") {
      content += event.delta;
      onDelta(event.delta);
    } else if (event.type === "done") {
      terminal = true;
      generation = event.generation;
    } else if (event.type === "stopped") {
      terminal = true;
      stopped = true;
      generation = event.generation;
    } else if (event.type === "error") {
      terminal = true;
      generation = event.generation;
      streamError = event.error;
      streamErrorGeneration = event.generation;
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
  if (streamError) {
    if (!streamErrorGeneration) throw new Error(streamError);
    throw new GenerationStreamError(streamError, streamErrorGeneration);
  }
  if (!terminal) throw new Error("The response stream disconnected");
  if (!generation) throw new Error("The response stream omitted generation details");
  if (!content && !stopped) throw new Error("The model returned no text");
  return { content, stopped, generation };
}

async function modelRequest(
  requestId: string,
  payload: unknown,
  onDelta: (delta: string) => void,
  onSnapshot: (content: string) => void,
  signal?: AbortSignal,
): Promise<GenerationResult> {
  const response = await fetch("/api/respond", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(payload as object), requestId }),
    signal,
  });
  return readGenerationStream(response, onDelta, onSnapshot);
}

async function resumeModelRequest(
  requestId: string,
  onDelta: (delta: string) => void,
  onSnapshot: (content: string) => void,
  signal?: AbortSignal,
): Promise<GenerationResult> {
  const response = await fetch(
    `/api/respond/${encodeURIComponent(requestId)}/stream`,
    { signal },
  );
  return readGenerationStream(response, onDelta, onSnapshot);
}

function extractVisualizationSource(response: string, engine: VisualizationEngine): string {
  const fenceLanguage = engine === "tikz" ? "(?:tikz|latex|tex)?" : "(?:metapost|mp)?";
  const fenced = response.match(
    new RegExp("```" + fenceLanguage + "\\s*\\n([\\s\\S]*?)```", "i"),
  )?.[1];
  let source = (fenced ?? response).trim();
  if (engine === "tikz") {
    source = source.match(/\\begin\s*\{tikzpicture\}(?:\[[^\]]*\])?([\s\S]*?)\\end\s*\{tikzpicture\}/i)?.[1]?.trim() ?? source;
  } else {
    source = source
      .replace(/^\s*outputformat\s*:=\s*["']svg["']\s*;\s*/i, "")
      .replace(/^\s*outputtemplate\s*:=\s*[^;]+;\s*/i, "")
      .replace(/^\s*prologues\s*:=\s*[^;]+;\s*/i, "")
      .replace(/^\s*beginfig\s*\(\s*1\s*\)\s*;\s*/i, "")
      .replace(/\s*endfig\s*;\s*end\s*\.\s*$/i, "")
      .trim();
  }
  if (!source) throw new Error(`The model returned no ${visualizationEngineLabel(engine)} source`);
  return source;
}

async function compileVisualizationRequest(
  engine: VisualizationEngine,
  source: string,
  signal?: AbortSignal,
): Promise<VisualizationCompileResult> {
  const response = await fetch(`/api/${engine}/compile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source }),
    signal,
  });
  const data = (await response.json().catch(() => ({}))) as
    | VisualizationCompileResult
    | { error?: string; log?: string };
  if (!response.ok) {
    const error = data as { error?: string; log?: string };
    throw new VisualizationCompileError(
      error.error ?? `${visualizationEngineLabel(engine)} compilation failed`,
      error.log,
    );
  }
  return data as VisualizationCompileResult;
}

function SelectionToolbar({
  selection,
  onDefine,
  onVisualize,
  onElaborate,
  onQuote,
  onDismiss,
}: {
  selection: SelectionDraft;
  onDefine: () => void;
  onVisualize: () => void;
  onElaborate: () => void;
  onQuote: () => void;
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
        left: Math.max(
          Math.min(250, window.innerWidth / 2),
          Math.min(
            window.innerWidth - Math.min(250, window.innerWidth / 2),
            rect.left + rect.width / 2,
          ),
        ),
        top: rect.top > 70 ? rect.top - 12 : rect.top + rect.height + 46,
      }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <span className="selection-toolbar__quote">
        “<InlineMath source={selection.quote} />”
      </span>
      <button className="selection-define-button" type="button" onClick={onDefine}>
        <BookOpen size={14} /> Define
      </button>
      <button className="selection-visualize-button" type="button" onClick={onVisualize}>
        <ChartNoAxesCombined size={14} /> Visualize
      </button>
      <button type="button" onClick={onElaborate}>
        <CornerUpRight size={14} /> Elaborate
      </button>
      <button className="selection-quote-button" type="button" onClick={onQuote}>
        <Quote size={14} /> Quote
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

function DefinitionPopover({
  definition,
  rect,
  getAnchorRect,
  onStop,
  onDismiss,
}: {
  definition: InlineDefinition;
  rect: SelectionDraft["rect"];
  getAnchorRect?: () => SelectionDraft["rect"];
  onStop: () => void;
  onDismiss: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [anchorRect, setAnchorRect] = useState(rect);
  const [position, setPosition] = useState({ left: rect.left, top: rect.top });

  useEffect(() => setAnchorRect(rect), [rect]);

  useEffect(() => {
    const popover = popoverRef.current;
    if (!popover) return;
    const place = () => {
      const bounds = popover.getBoundingClientRect();
      const left = Math.min(
        window.innerWidth - bounds.width - 12,
        Math.max(12, anchorRect.left + anchorRect.width / 2 - bounds.width / 2),
      );
      const below = anchorRect.top + anchorRect.height + 10;
      const preferredTop =
        below + bounds.height <= window.innerHeight - 12
          ? below
          : anchorRect.top - bounds.height - 10;
      const top = Math.min(
        window.innerHeight - bounds.height - 12,
        Math.max(12, preferredTop),
      );
      setPosition({ left, top });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(popover);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [definition.id, definition.content, definition.pending, anchorRect]);

  useEffect(() => {
    const dismissOnPointer = (event: PointerEvent) => {
      if (popoverRef.current?.contains(event.target as Node)) return;
      if (definition.pending) return;
      onDismiss();
    };
    const dismissOnKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    const dismissOnScroll = (event: Event) => {
      if (
        event.target instanceof Node &&
        popoverRef.current?.contains(event.target)
      ) {
        return;
      }
      if (definition.pending) {
        const nextRect = getAnchorRect?.();
        if (nextRect && (nextRect.width || nextRect.height)) {
          setAnchorRect(nextRect);
        }
        return;
      }
      onDismiss();
    };
    document.addEventListener("pointerdown", dismissOnPointer);
    document.addEventListener("keydown", dismissOnKey);
    document.addEventListener("scroll", dismissOnScroll, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOnPointer);
      document.removeEventListener("keydown", dismissOnKey);
      document.removeEventListener("scroll", dismissOnScroll, true);
    };
  }, [definition.pending, getAnchorRect, onDismiss]);

  return (
    <div
      className="definition-popover"
      ref={popoverRef}
      role="dialog"
      aria-label="Definition"
      style={{ left: position.left, top: position.top }}
    >
      <header>
        <span><BookOpen size={13} /> Definition</span>
        <button type="button" aria-label="Close definition" onClick={onDismiss}>
          <X size={13} />
        </button>
      </header>
      {definition.pending ? (
        <div className="definition-popover__loading" aria-live="polite">
          <span /> Defining…
          <button type="button" onClick={onStop}>Stop</button>
        </div>
      ) : (
        <MathBlock
          className={definition.error ? "definition-popover__error" : ""}
          source={definition.content}
        />
      )}
      {!definition.pending && definition.generation && (
        <footer>{generationDetails(definition.generation)}</footer>
      )}
    </div>
  );
}

function NewChatScreen({
  initialMode,
  onCreate,
  onOpenSidebar,
  categories,
  provider,
  modelOptions,
  model,
  onModelChange,
  reasoningEffort,
  onReasoningEffortChange,
  sendShortcut,
}: {
  initialMode: "ask" | "import";
  onCreate: (
    mode: "ask" | "import",
    content: string,
    title: string,
    categoryId: string | null,
  ) => void;
  onOpenSidebar: () => void;
  categories: ChatCategory[];
  provider: ProviderId;
  modelOptions: ProviderModelOption[];
  model: string;
  onModelChange: (model: string) => void;
  reasoningEffort: ReasoningEffort;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  sendShortcut: WorkspaceState["settings"]["sendShortcut"];
}) {
  const [mode, setMode] = useState(initialMode);
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [categoryId, setCategoryId] = useState("");

  useEffect(() => setMode(initialMode), [initialMode]);
  useEffect(() => {
    if (categoryId && !categories.some((category) => category.id === categoryId)) {
      setCategoryId("");
    }
  }, [categories, categoryId]);

  const submitNewChat = () => {
    if (!content.trim() || (mode === "ask" && !model.trim())) return;
    onCreate(mode, content.trim(), title.trim(), categoryId || null);
  };

  return (
    <main className="new-chat">
      <button
        className="new-chat__sidebar-button"
        type="button"
        aria-label="Open studies"
        onClick={onOpenSidebar}
      >
        <Menu size={19} />
      </button>
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
        <p className="eyebrow">Locus Chat</p>
        <h1>Dive deep into any topic</h1>
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
          <div className="start-card__meta">
            <input
              className="title-input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Title (optional)"
              aria-label="Chat title"
            />
            <select
              className="start-card__category"
              aria-label="Category for new chat"
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
            >
              <option value="">Uncategorized</option>
              {categories.map((category) => (
                <option value={category.id} key={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>
          <textarea
            autoFocus
            value={content}
            onChange={(event) => setContent(event.target.value)}
            onKeyDown={(event) => {
              if (applyMarkdownShortcut(event, content, setContent)) return;
              if (isSendShortcut(event, sendShortcut)) {
                event.preventDefault();
                submitNewChat();
              }
            }}
            rows={9}
            placeholder={
              mode === "import"
                ? "Paste Markdown here — nothing is sent to the model.\n\nEquations like $\\nabla_\\theta L$ render automatically."
                : "What are you trying to understand? Include as much context as you like."
            }
            aria-label={mode === "import" ? "Markdown to import" : "Question for Locus"}
          />
          <div className="start-card__footer">
            {mode === "ask" ? (
              <ModelPicker
                className="start-card__model-picker"
                provider={provider}
                modelOptions={modelOptions}
                value={model}
                onChange={onModelChange}
                reasoningEffort={reasoningEffort}
                onReasoningEffortChange={onReasoningEffortChange}
                ariaLabel="Model for new chat"
                reasoningAriaLabel="Reasoning effort for new chat"
              />
            ) : (
              <span>Saved without a model call</span>
            )}
            <button
              className="primary-button"
              type="button"
              disabled={!content.trim() || (mode === "ask" && !model.trim())}
              onClick={submitNewChat}
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

export default function App({
  runtime,
  onSignOut,
}: {
  runtime: RuntimeInfo;
  onSignOut: () => Promise<void>;
}) {
  const [workspace, setWorkspace] = useState<WorkspaceState>(DEFAULT_STATE);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [selection, setSelection] = useState<SelectionDraft | null>(null);
  const [draft, setDraft] = useState<SelectionDraft | null>(null);
  const [definitionPopover, setDefinitionPopover] = useState<{
    chatId: string;
    nodeId: string;
    definitionId: string;
    rect: SelectionDraft["rect"];
    getAnchorRect?: () => SelectionDraft["rect"];
  } | null>(null);
  const draftReturnView = useRef<{
    chatId: string;
    nodeId: string;
    maximized: boolean;
  } | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [composerInsertion, setComposerInsertion] = useState<{
    id: string;
    nodeId: string;
    value: string;
  } | null>(null);
  const [newMode, setNewMode] = useState<"ask" | "import">("ask");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [adminAccountsOpen, setAdminAccountsOpen] = useState(false);
  const [sharedChatsOpen, setSharedChatsOpen] = useState(false);
  const [shareCreating, setShareCreating] = useState(false);
  const [shareResult, setShareResult] = useState<SharedChatSummary | null>(null);
  const [shareError, setShareError] = useState("");
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [customInstructionsOpen, setCustomInstructionsOpen] = useState(false);
  const [customInstructionsDraft, setCustomInstructionsDraft] = useState("");
  const [providerStatuses, setProviderStatuses] = useState<ProviderStatuses | null>(null);
  const [credentialProvider, setCredentialProvider] = useState<ProviderId>("openai");
  const [apiKeyOpen, setApiKeyOpen] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [apiKeyError, setApiKeyError] = useState("");
  const [providerModels, setProviderModels] = useState<ProviderModelOption[]>([]);
  const [providerModelsStatus, setProviderModelsStatus] =
    useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [drawerWidth, setDrawerWidth] = useState(440);
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [renamingNodeId, setRenamingNodeId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [categoryMenuId, setCategoryMenuId] = useState<string | null>(null);
  const [categoryEditor, setCategoryEditor] = useState<{
    categoryId: string | null;
    name: string;
  } | null>(null);
  const [jsonImportOpen, setJsonImportOpen] = useState(false);
  const [jsonImport, setJsonImport] = useState<ParsedChatImport | null>(null);
  const [jsonImportFilename, setJsonImportFilename] = useState("");
  const [jsonImportError, setJsonImportError] = useState("");
  const [jsonImportTarget, setJsonImportTarget] = useState("uncategorized");
  const [jsonImportNewCategory, setJsonImportNewCategory] = useState("");
  const [threadScrollRequest, setThreadScrollRequest] =
    useState<ThreadScrollRequest | null>(null);
  const [focusMaximized, setFocusMaximized] = useState(false);
  const responseControllers = useRef(new Map<string, AbortController>());
  const visualizationCompiles = useRef(new Set<string>());
  const assistantDeltaBuffers = useRef(
    new Map<string, { chatId: string; nodeId: string; delta: string }>(),
  );
  const assistantDeltaFrame = useRef<number | null>(null);
  const workspaceRef = useRef(workspace);
  const lastSavedWorkspaceRef = useRef<WorkspaceState | null>(null);
  const hostedRevisionRef = useRef(0);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const activeNodeIdRef = useRef(activeNodeId);
  const historyAction = useRef<"push" | "replace">("replace");
  workspaceRef.current = workspace;
  activeNodeIdRef.current = activeNodeId;

  useEffect(
    () => () => {
      if (assistantDeltaFrame.current !== null) {
        window.cancelAnimationFrame(assistantDeltaFrame.current);
      }
      assistantDeltaBuffers.current.clear();
    },
    [],
  );

  const activeChat = workspace.chats.find((chat) => chat.id === workspace.activeChatId) ?? null;
  const isAdministrator = runtime.mode === "hosted" && Boolean(
    runtime.user?.role?.split(",").includes("admin"),
  );
  const rootNode = activeChat ? activeChat.nodes[activeChat.rootId] : null;
  const activeNode =
    activeChat && activeNodeId && activeChat.nodes[activeNodeId]
      ? activeChat.nodes[activeNodeId]
      : rootNode;
  const sideNode = activeNode && rootNode && activeNode.id !== rootNode.id ? activeNode : null;
  const leftPaneNode =
    activeChat && rootNode
      ? draft
        ? activeChat.nodes[draft.sourceNodeId] ?? rootNode
        : sideNode?.parentId
          ? activeChat.nodes[sideNode.parentId] ?? rootNode
          : rootNode
      : null;

  const closeElaborationDraft = () => {
    if (!draftRef.current) {
      draftReturnView.current = null;
      setDraft(null);
      return;
    }
    const returnView = draftReturnView.current;
    draftReturnView.current = null;
    setDraft(null);
    if (!returnView) return;

    const chat = workspaceRef.current.chats.find(
      (item) => item.id === returnView.chatId,
    );
    if (!chat || !chat.nodes[returnView.nodeId]) return;

    historyAction.current = "push";
    setActiveNodeId(returnView.nodeId);
    setFocusMaximized(
      returnView.maximized && returnView.nodeId !== chat.rootId,
    );
  };

  const closeFocusedThread = () => {
    if (!activeChat || !rootNode || !sideNode?.parentId) return;
    const parent = activeChat.nodes[sideNode.parentId];
    if (!parent) return;

    historyAction.current = "push";
    if (sideNode.anchor) {
      setThreadScrollRequest({
        id: newId(),
        nodeId: parent.id,
        anchor: sideNode.anchor,
      });
    }
    setActiveNodeId(parent.id);
    setFocusMaximized(parent.id !== rootNode.id);
  };

  const deleteBranchSubtree = (nodeId: string) => {
    if (!activeChat || nodeId === activeChat.rootId) return;
    const node = activeChat.nodes[nodeId];
    const parent = node?.parentId ? activeChat.nodes[node.parentId] : null;
    if (!node || !parent) return;

    const subtreeIds = branchSubtreeIds(activeChat, nodeId);
    const nestedCount = subtreeIds.length - 1;
    const confirmed = window.confirm(
      nestedCount
        ? `Delete “${node.title}” and its ${nestedCount} nested elaboration${nestedCount === 1 ? "" : "s"}? This cannot be undone.`
        : `Delete “${node.title}”? This cannot be undone.`,
    );
    if (!confirmed) return;

    const removedIds = new Set(subtreeIds);
    pendingGenerations(workspaceRef.current)
      .filter(
        (pending) =>
          pending.chatId === activeChat.id && removedIds.has(pending.nodeId),
      )
      .forEach((pending) => {
        assistantDeltaBuffers.current.delete(pending.assistantId);
        const controller = responseControllers.current.get(pending.assistantId);
        void fetch(`/api/respond/${encodeURIComponent(pending.requestId)}/abort`, {
          method: "POST",
        })
          .catch(() => undefined)
          .finally(() => {
            controller?.abort();
            if (responseControllers.current.get(pending.assistantId) === controller) {
              responseControllers.current.delete(pending.assistantId);
            }
          });
      });

    const activeWasRemoved = Boolean(
      activeNodeIdRef.current && removedIds.has(activeNodeIdRef.current),
    );
    const draftWasRemoved = Boolean(
      draftRef.current && removedIds.has(draftRef.current.sourceNodeId),
    );
    const shouldReturnToParent = activeWasRemoved || draftWasRemoved;

    setWorkspace((current) => ({
      ...current,
      chats: current.chats.map((chat) => {
        if (chat.id !== activeChat.id) return chat;
        return {
          ...chat,
          updatedAt: timestamp(),
          nodes: Object.fromEntries(
            Object.entries(chat.nodes).filter(([id]) => !removedIds.has(id)),
          ),
        };
      }),
    }));
    setSelection(null);
    setDefinitionPopover((current) =>
      current && removedIds.has(current.nodeId) ? null : current,
    );
    setComposerInsertion((current) =>
      current && removedIds.has(current.nodeId) ? null : current,
    );
    setThreadScrollRequest((current) =>
      current && removedIds.has(current.nodeId) ? null : current,
    );
    setRenamingNodeId((current) =>
      current && removedIds.has(current) ? null : current,
    );
    setBranchMenuOpen(false);

    if (draftWasRemoved) {
      draftReturnView.current = null;
      setDraft(null);
    }
    if (shouldReturnToParent) {
      historyAction.current = "push";
      setActiveNodeId(parent.id);
      setFocusMaximized(parent.id !== activeChat.rootId);
      if (node.anchor) {
        setThreadScrollRequest({
          id: newId(),
          nodeId: parent.id,
          anchor: node.anchor,
        });
      }
    }
  };

  useEffect(() => {
    setLoadError("");
    const endpoint = runtime.mode === "hosted" ? "/api/workspace" : "/api/state";
    fetch(endpoint, { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load your workspace");
        return runtime.mode === "hosted"
          ? ((await response.json()) as HostedWorkspaceResponse)
          : ({ state: (await response.json()) as WorkspaceState, revision: 0 } satisfies HostedWorkspaceResponse);
      })
      .then(({ state, revision }) => {
        const requestedView = readViewLocation();
        const chat = requestedView.chatId
          ? state.chats.find((item) => item.id === requestedView.chatId) ?? null
          : state.chats.find((item) => item.id === state.activeChatId) ?? null;
        const requestedNode =
          chat && requestedView.nodeId && chat.nodes[requestedView.nodeId]
            ? requestedView.nodeId
            : chat?.rootId ?? null;
        const nextState = { ...state, activeChatId: chat?.id ?? null };
        hostedRevisionRef.current = revision;
        lastSavedWorkspaceRef.current = nextState;
        workspaceRef.current = nextState;
        setWorkspace(nextState);
        setDrawerWidth(state.settings.focusDrawerWidth ?? 440);
        setActiveNodeId(requestedNode);
        const requestedThread = requestedNode ? chat?.nodes[requestedNode] : null;
        if (
          chat &&
          requestedThread?.parentId === chat.rootId &&
          requestedThread.anchor
        ) {
          setThreadScrollRequest({
            id: newId(),
            nodeId: chat.rootId,
            anchor: requestedThread.anchor,
          });
        }
        setFocusMaximized(
          Boolean(chat && requestedNode !== chat.rootId && requestedView.maximized),
        );
      })
      .catch((error) => {
        if (runtime.mode === "local") {
          lastSavedWorkspaceRef.current = DEFAULT_STATE;
          setWorkspace(DEFAULT_STATE);
        } else {
          setLoadError(error instanceof Error ? error.message : "Could not load your workspace");
        }
      })
      .finally(() => setLoaded(true));
  }, [runtime.mode]);

  useEffect(() => {
    if (!loaded) return;
    const applyLocation = () => {
      const requestedView = readViewLocation();
      const state = workspaceRef.current;
      const chat = requestedView.chatId
        ? state.chats.find((item) => item.id === requestedView.chatId) ?? null
        : null;
      const nodeId =
        chat && requestedView.nodeId && chat.nodes[requestedView.nodeId]
          ? requestedView.nodeId
          : chat?.rootId ?? null;
      const previousNodeId = activeNodeIdRef.current;
      const previousNode =
        chat && state.activeChatId === chat.id && previousNodeId
          ? chat.nodes[previousNodeId]
          : null;
      if (previousNode?.parentId === nodeId && previousNode.anchor && nodeId) {
        setThreadScrollRequest({
          id: newId(),
          nodeId,
          anchor: previousNode.anchor,
        });
      }
      historyAction.current = "replace";
      setWorkspace((current) => ({ ...current, activeChatId: chat?.id ?? null }));
      setActiveNodeId(nodeId);
      setFocusMaximized(Boolean(chat && nodeId !== chat.rootId && requestedView.maximized));
      setDraft(null);
      setSelection(null);
      setDefinitionPopover(null);
      setChatMenuOpen(false);
      setBranchMenuOpen(false);
    };
    window.addEventListener("popstate", applyLocation);
    return () => window.removeEventListener("popstate", applyLocation);
  }, [loaded]);

  useEffect(() => {
    if (!loaded) return;
    const url = viewUrl(activeChat, activeNode?.id ?? null, focusMaximized);
    const currentUrl = `${window.location.pathname}${window.location.search}`;
    const method = historyAction.current;
    historyAction.current = "replace";
    if (url !== currentUrl) {
      const state = {
        chatId: activeChat?.id ?? null,
        nodeId: activeNode?.id ?? null,
        maximized: Boolean(sideNode && focusMaximized),
      };
      if (method === "push") window.history.pushState(state, "", url);
      else window.history.replaceState(state, "", url);
    }
    document.title = activeChat
      ? sideNode
        ? `${sideNode.title} — ${activeChat.title} · Locus`
        : `${activeChat.title} · Locus`
      : "Locus";
  }, [loaded, activeChat?.id, activeChat?.title, activeNode?.id, activeNode?.title, focusMaximized]);

  useEffect(() => {
    fetch("/api/providers")
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not check provider credentials");
        return (await response.json()) as ProviderStatuses;
      })
      .then(setProviderStatuses)
      .catch(() => setProviderStatuses(null));
  }, []);

  useEffect(() => {
    if (!loaded || workspace.settings.provider === "openai") {
      setProviderModels([]);
      setProviderModelsStatus("idle");
      return;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setProviderModelsStatus("loading");
      const query =
        workspace.settings.provider === "local"
          ? `?baseUrl=${encodeURIComponent(workspace.settings.localBaseUrl)}`
          : "";
      fetch(`/api/providers/${workspace.settings.provider}/models${query}`, {
        signal: controller.signal,
      })
        .then(async (response) => {
          const data = (await response.json().catch(() => ({}))) as
            | { models: ProviderModelOption[] }
            | ApiError;
          if (!response.ok || !("models" in data)) {
            throw new Error("error" in data ? data.error : "Could not load models");
          }
          return data.models;
        })
        .then((models) => {
          setProviderModels(models);
          setProviderModelsStatus("loaded");
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setProviderModels([]);
          setProviderModelsStatus("error");
        });
    }, 450);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [loaded, workspace.settings.provider, workspace.settings.localBaseUrl]);

  useEffect(() => {
    if (!loaded || loadError) return;
    setSaveState("saving");
    const timeout = window.setTimeout(() => {
      const target = workspace;
      saveQueueRef.current = saveQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          if (runtime.mode === "local") {
            const response = await fetch("/api/state", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(target),
            });
            if (!response.ok) throw new Error("Save failed");
            lastSavedWorkspaceRef.current = target;
            setSaveState("saved");
            return;
          }

          const baseline = lastSavedWorkspaceRef.current;
          if (!baseline) throw new Error("Workspace has not finished loading");
          const changes = workspaceSyncChanges(baseline, target, hostedRevisionRef.current);
          if (!changes) {
            setSaveState("saved");
            return;
          }
          const response = await fetch("/api/workspace/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify(changes),
          });
          const result = (await response.json().catch(() => ({}))) as {
            revision?: number;
            error?: string;
          };
          if (response.status === 401) {
            window.location.reload();
            throw new Error("Session expired");
          }
          if (response.status === 409) {
            throw new Error("This workspace changed in another tab. Reload before editing further.");
          }
          if (!response.ok || !Number.isSafeInteger(result.revision)) {
            throw new Error(result.error ?? "Save failed");
          }
          hostedRevisionRef.current = result.revision!;
          lastSavedWorkspaceRef.current = target;
          setSaveState("saved");
        })
        .catch(() => setSaveState("error"));
    }, 350);
    return () => window.clearTimeout(timeout);
  }, [loaded, loadError, runtime.mode, workspace]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelection(null);
        setDefinitionPopover(null);
        window.getSelection()?.removeAllRanges();
        closeElaborationDraft();
        setSettingsOpen(false);
        setCustomInstructionsOpen(false);
        setApiKeyOpen(false);
        setApiKeyDraft("");
        setApiKeyError("");
        setChatMenuOpen(false);
        setBranchMenuOpen(false);
        setRenamingNodeId(null);
        setCategoryMenuId(null);
        setCategoryEditor(null);
        setJsonImportOpen(false);
        setSharedChatsOpen(false);
        setShareResult(null);
        setShareError("");
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

  const shareActiveChat = async () => {
    const chatId = workspaceRef.current.activeChatId;
    if (runtime.mode !== "hosted" || !chatId || shareCreating) return;
    setShareCreating(true);
    setShareError("");
    try {
      // Let the debounced workspace save enqueue, then wait for it. The server
      // creates the snapshot from its own persisted copy, never from client JSON.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 400));
      await saveQueueRef.current;
      const persistedChat = lastSavedWorkspaceRef.current?.chats.find((chat) => chat.id === chatId);
      const currentChat = workspaceRef.current.chats.find((chat) => chat.id === chatId);
      if (!persistedChat || !currentChat || persistedChat.updatedAt !== currentChat.updatedAt) {
        throw new Error("This chat has not finished saving yet. Try sharing again in a moment.");
      }
      const response = await fetch("/api/shares", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        share?: SharedChatSummary;
        error?: string;
      };
      if (!response.ok || !result.share) {
        throw new Error(result.error ?? "Could not create a public link");
      }
      setShareResult(result.share);
    } catch (reason) {
      setShareError(reason instanceof Error ? reason.message : "Could not create a public link");
    } finally {
      setShareCreating(false);
    }
  };

  const updateAssistantMessage = (
    chatId: string,
    nodeId: string,
    assistantId: string,
    update: (message: Message) => Message,
    touchChat = false,
  ) => {
    updateChat(chatId, (chat) => {
      const node = chat.nodes[nodeId];
      if (!node) return chat;
      let changed = false;
      const messages = node.messages.map((message) => {
        if (message.id !== assistantId) return message;
        changed = true;
        return update(message);
      });
      const messageRevisions = Object.fromEntries(
        Object.entries(node.messageRevisions ?? {}).map(([groupId, group]) => [
          groupId,
          {
            ...group,
            variants: group.variants.map((variant) => {
              if (variant.assistantMessage.id !== assistantId) return variant;
              changed = true;
              return { ...variant, assistantMessage: update(variant.assistantMessage) };
            }),
          },
        ]),
      );
      const responseRevisions = node.responseRevisions
        ? Object.fromEntries(
            Object.entries(node.responseRevisions).map(([groupId, group]) => [
              groupId,
              {
                ...group,
                responses: group.responses.map((response) => {
                  if (response.id !== assistantId) return response;
                  changed = true;
                  return update(response);
                }),
              },
            ]),
          )
        : undefined;
      if (!changed) return chat;
      const updatedAt = touchChat ? timestamp() : chat.updatedAt;
      return {
        ...chat,
        updatedAt,
        nodes: {
          ...chat.nodes,
          [nodeId]: {
            ...node,
            updatedAt: touchChat ? updatedAt : node.updatedAt,
            messages,
            messageRevisions,
            responseRevisions,
          },
        },
      };
    });
  };

  const updateDefinition = (
    chatId: string,
    nodeId: string,
    definitionId: string,
    update: (definition: InlineDefinition) => InlineDefinition,
  ) => {
    updateChat(chatId, (chat) => {
      const node = chat.nodes[nodeId];
      if (!node?.definitions?.some((definition) => definition.id === definitionId)) {
        return chat;
      }
      const updatedAt = timestamp();
      return {
        ...chat,
        updatedAt,
        nodes: {
          ...chat.nodes,
          [nodeId]: {
            ...node,
            updatedAt,
            definitions: node.definitions.map((definition) =>
              definition.id === definitionId ? update(definition) : definition,
            ),
          },
        },
      };
    });
  };

  const updateVisualization = (
    chatId: string,
    nodeId: string,
    visualizationId: string,
    update: (visualization: InlineVisualization) => InlineVisualization,
  ) => {
    updateChat(chatId, (chat) => {
      const node = chat.nodes[nodeId];
      if (!node?.visualizations?.some((visualization) => visualization.id === visualizationId)) {
        return chat;
      }
      const updatedAt = timestamp();
      return {
        ...chat,
        updatedAt,
        nodes: {
          ...chat.nodes,
          [nodeId]: {
            ...node,
            updatedAt,
            visualizations: node.visualizations.map((visualization) =>
              visualization.id === visualizationId ? update(visualization) : visualization,
            ),
          },
        },
      };
    });
  };

  const discardAssistantDelta = (assistantId: string) => {
    assistantDeltaBuffers.current.delete(assistantId);
    if (
      assistantDeltaBuffers.current.size === 0 &&
      assistantDeltaFrame.current !== null
    ) {
      window.cancelAnimationFrame(assistantDeltaFrame.current);
      assistantDeltaFrame.current = null;
    }
  };

  const flushAssistantDeltas = () => {
    if (assistantDeltaFrame.current !== null) {
      window.cancelAnimationFrame(assistantDeltaFrame.current);
    }
    assistantDeltaFrame.current = null;
    const pending = Array.from(assistantDeltaBuffers.current.entries());
    assistantDeltaBuffers.current.clear();
    pending.forEach(([assistantId, buffered]) => {
      updateAssistantMessage(
        buffered.chatId,
        buffered.nodeId,
        assistantId,
        (message) => ({
          ...message,
          content: `${message.content}${buffered.delta}`,
        }),
      );
    });
  };

  const finishAssistant = (
    chatId: string,
    nodeId: string,
    assistantId: string,
    content: string,
    error = false,
    generation?: GenerationMetrics,
  ) => {
    discardAssistantDelta(assistantId);
    updateAssistantMessage(
      chatId,
      nodeId,
      assistantId,
      (message) => ({
        ...message,
        content,
        pending: false,
        error,
        stopped: false,
        generation,
      }),
      true,
    );
  };

  const appendAssistantDelta = (
    chatId: string,
    nodeId: string,
    assistantId: string,
    delta: string,
  ) => {
    const buffered = assistantDeltaBuffers.current.get(assistantId);
    if (buffered) buffered.delta += delta;
    else assistantDeltaBuffers.current.set(assistantId, { chatId, nodeId, delta });
    if (assistantDeltaFrame.current === null) {
      assistantDeltaFrame.current = window.requestAnimationFrame(flushAssistantDeltas);
    }
  };

  const replaceAssistantContent = (
    chatId: string,
    nodeId: string,
    assistantId: string,
    content: string,
  ) => {
    discardAssistantDelta(assistantId);
    updateAssistantMessage(chatId, nodeId, assistantId, (message) => ({
      ...message,
      content,
    }));
  };

  const markAssistantStopped = (
    chatId: string,
    nodeId: string,
    assistantId: string,
    generation?: GenerationMetrics,
    content?: string,
  ) => {
    discardAssistantDelta(assistantId);
    updateAssistantMessage(
      chatId,
      nodeId,
      assistantId,
      (message) => ({
        ...message,
        pending: false,
        error: false,
        stopped: true,
        generation,
        ...(content === undefined ? {} : { content }),
      }),
      true,
    );
  };

  const askModel = async (
    chat: ChatTree,
    nodeId: string,
    userMessage: Message,
    assistantId: string,
    requestId: string,
    anchor?: HighlightAnchor,
  ) => {
    const controller = new AbortController();
    responseControllers.current.set(assistantId, controller);
    try {
      const result = await modelRequest(
        requestId,
        {
          provider: workspace.settings.provider,
          localBaseUrl: workspace.settings.localBaseUrl,
          model: workspace.settings.model,
          reasoningEffort: workspace.settings.reasoningEffort,
          maxOutputTokens: workspace.settings.maxOutputTokens,
          customInstructions: workspace.settings.customInstructions,
          context: contextFor(chat, nodeId, [userMessage.id, assistantId]),
          message: userMessage.content,
          anchor,
        },
        (delta) => appendAssistantDelta(chat.id, nodeId, assistantId, delta),
        (content) => replaceAssistantContent(chat.id, nodeId, assistantId, content),
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (result.stopped) {
        markAssistantStopped(
          chat.id,
          nodeId,
          assistantId,
          result.generation,
          result.content,
        );
      }
      else finishAssistant(chat.id, nodeId, assistantId, result.content, false, result.generation);
    } catch (error) {
      if (controller.signal.aborted) return;
      finishAssistant(
        chat.id,
        nodeId,
        assistantId,
        error instanceof Error ? error.message : "The request failed",
        true,
        error instanceof GenerationStreamError ? error.generation : undefined,
      );
    } finally {
      if (responseControllers.current.get(assistantId) === controller) {
        responseControllers.current.delete(assistantId);
      }
    }
  };

  const askDefinition = async (
    chat: ChatTree,
    nodeId: string,
    definition: InlineDefinition,
  ) => {
    if (!definition.requestId) return;
    const node = chat.nodes[nodeId];
    const sourceMessage = node
      ? messagesForNode(node).find(
          (message) => message.id === definition.anchor.sourceMessageId,
        )
      : null;
    if (!node || !sourceMessage) {
      updateDefinition(chat.id, nodeId, definition.id, (current) => ({
        ...current,
        content: "The selected message is no longer available.",
        pending: false,
        error: true,
      }));
      return;
    }
    const controller = new AbortController();
    responseControllers.current.set(definition.id, controller);
    try {
      const definitionModel =
        workspace.settings.definitionModels[workspace.settings.provider]?.trim() ||
        workspace.settings.model;
      const result = await modelRequest(
        definition.requestId,
        {
          provider: workspace.settings.provider,
          localBaseUrl: workspace.settings.localBaseUrl,
          model: definitionModel,
          reasoningEffort: compatibleReasoningEffort(
            workspace.settings.provider,
            definitionModel,
            workspace.settings.reasoningEffort,
          ),
          maxOutputTokens: workspace.settings.maxOutputTokens,
          customInstructions: workspace.settings.customInstructions,
          context: [
            {
              title: node.title,
              messages: [
                {
                  role: sourceMessage.role,
                  content: sourceMessage.content,
                },
              ],
            },
          ],
          message:
            "Define or explain only the selected passage in one concise paragraph. Return the paragraph directly: no heading, list, preamble, follow-up question, or second paragraph. Preserve useful mathematical notation with inline LaTeX.",
          anchor: definition.anchor,
          purpose: "definition",
        },
        () => undefined,
        () => undefined,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const content = oneParagraph(result.content);
      updateDefinition(chat.id, nodeId, definition.id, (current) => ({
        ...current,
        content: content || "No definition was returned.",
        pending: false,
        error: result.stopped || !content,
        generation: result.generation,
      }));
    } catch (error) {
      if (controller.signal.aborted) return;
      updateDefinition(chat.id, nodeId, definition.id, (current) => ({
        ...current,
        content: error instanceof Error ? error.message : "The definition request failed",
        pending: false,
        error: true,
        generation:
          error instanceof GenerationStreamError ? error.generation : undefined,
      }));
    } finally {
      if (responseControllers.current.get(definition.id) === controller) {
        responseControllers.current.delete(definition.id);
      }
    }
  };

  const stopDefinition = async (
    chatId: string,
    nodeId: string,
    definitionId: string,
  ) => {
    const chat = workspaceRef.current.chats.find((item) => item.id === chatId);
    const definition = chat?.nodes[nodeId]?.definitions?.find(
      (item) => item.id === definitionId,
    );
    if (!definition?.pending || !definition.requestId) return;
    try {
      const response = await fetch(
        `/api/respond/${encodeURIComponent(definition.requestId)}/abort`,
        { method: "POST" },
      );
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as ApiError;
        throw new Error(data.error ?? "The server could not stop this definition");
      }
      const data = (await response.json()) as {
        stopped: boolean;
        generation: GenerationMetrics;
      };
      responseControllers.current.get(definition.id)?.abort();
      updateDefinition(chatId, nodeId, definitionId, (current) => ({
        ...current,
        content: "Definition stopped.",
        pending: false,
        error: true,
        generation: data.generation,
      }));
    } catch (error) {
      window.alert(
        error instanceof Error ? error.message : "The definition could not be stopped",
      );
    }
  };

  const compileVisualization = async (
    chatId: string,
    nodeId: string,
    visualizationId: string,
    source: string,
    generation?: GenerationMetrics,
    engineOverride?: VisualizationEngine,
  ): Promise<VisualizationCompileError | null> => {
    const storedVisualization = workspaceRef.current.chats
      .find((chat) => chat.id === chatId)
      ?.nodes[nodeId]?.visualizations?.find((item) => item.id === visualizationId);
    const engine = engineOverride ?? visualizationEngine(storedVisualization ?? { engine: undefined });
    const compileKey = `${chatId}:${nodeId}:${visualizationId}`;
    if (visualizationCompiles.current.has(compileKey)) {
      return new VisualizationCompileError("This visualization is already compiling.");
    }
    visualizationCompiles.current.add(compileKey);
    const updatedAt = timestamp();
    updateVisualization(chatId, nodeId, visualizationId, (current) => ({
      ...current,
      status: "compiling",
      engine,
      source,
      svg: undefined,
      errorStage: undefined,
      errorMessage: undefined,
      compilerLog: undefined,
      requestId: undefined,
      generation: generation ?? current.generation,
      updatedAt,
    }));
    try {
      const result = await compileVisualizationRequest(engine, source);
      updateVisualization(chatId, nodeId, visualizationId, (current) => ({
        ...current,
        status: "ready",
        svg: result.svg,
        compilerLog: result.log,
        compileDurationMs: result.durationMs,
        updatedAt: timestamp(),
      }));
      visualizationCompiles.current.delete(compileKey);
      return null;
    } catch (error) {
      updateVisualization(chatId, nodeId, visualizationId, (current) => ({
        ...current,
        status: "error",
        errorStage: "compile",
        errorMessage:
          error instanceof Error
            ? error.message
            : `${visualizationEngineLabel(engine)} compilation failed`,
        compilerLog: error instanceof VisualizationCompileError ? error.log : "",
        updatedAt: timestamp(),
      }));
      visualizationCompiles.current.delete(compileKey);
      return error instanceof VisualizationCompileError
        ? error
        : new VisualizationCompileError(
            error instanceof Error
              ? error.message
              : `${visualizationEngineLabel(engine)} compilation failed`,
          );
    }
  };

  const generateVisualization = async (
    chatId: string,
    nodeId: string,
    visualizationId: string,
    hint: string,
    engineOverride?: VisualizationEngine,
    followup?: VisualizationFollowup,
  ): Promise<void> => {
    const chat = workspaceRef.current.chats.find((item) => item.id === chatId);
    const node = chat?.nodes[nodeId];
    const visualization = node?.visualizations?.find((item) => item.id === visualizationId);
    const sourceMessage = node
      ? messagesForNode(node).find(
          (message) => message.id === visualization?.anchor.sourceMessageId,
        )
      : null;
    if (!chat || !node || !visualization || !sourceMessage) return;
    const engine = engineOverride ?? visualizationEngine(visualization);
    const engineLabel = visualizationEngineLabel(engine);

    if (followup?.kind !== "repair") {
      try {
        const statusResponse = await fetch(`/api/${engine}/status`);
        const status = (await statusResponse.json()) as { available?: boolean } & ApiError;
        if (!statusResponse.ok || !status.available) {
          updateVisualization(chatId, nodeId, visualizationId, (current) => ({
            ...current,
            hint,
            status: "error",
            errorStage: "compile",
            errorMessage:
              status.error ?? "The compiler image is unavailable. Run: npm run metapost:build",
            updatedAt: timestamp(),
          }));
          return;
        }
      } catch {
        updateVisualization(chatId, nodeId, visualizationId, (current) => ({
          ...current,
          hint,
          status: "error",
          errorStage: "compile",
          errorMessage: `Could not verify the ${engineLabel} compiler before generation.`,
          updatedAt: timestamp(),
        }));
        return;
      }
    }

    const requestId = newId();
    updateVisualization(chatId, nodeId, visualizationId, (current) => ({
      ...current,
      hint,
      engine,
      status: "generating",
      requestId,
      svg: followup ? current.svg : undefined,
      errorStage: undefined,
      errorMessage: undefined,
      compilerLog: followup?.kind === "repair" ? followup.diagnostic : undefined,
      updatedAt: timestamp(),
    }));
    const controller = new AbortController();
    responseControllers.current.set(visualizationId, controller);
    try {
      const visualizationModel =
        workspaceRef.current.settings.visualizationModels[
          workspaceRef.current.settings.provider
        ]?.trim() || workspaceRef.current.settings.model;
      const prompt = followup?.kind === "repair"
        ? `Repair the following ${engineLabel} figure body so it compiles under the required restricted output contract. Preserve its intended content and return only the corrected body.\n\n<failed_source>\n${followup.source}\n</failed_source>\n\n<compiler_log>\n${followup.diagnostic.slice(-12_000)}\n</compiler_log>`
        : followup?.kind === "revision"
          ? `Revise the following existing ${engineLabel} figure body according to the one-time instruction. Return the complete replacement figure body, preserve everything that already works, and make only the changes needed to satisfy the instruction. Do not describe the changes.\n\n<existing_source>\n${followup.source}\n</existing_source>\n\n<revision_request>\n${followup.instruction}\n</revision_request>`
          : `Create a clear, static mathematical diagram of the highlighted passage. Use the containing message to resolve symbols. ${
              hint
                ? `Follow this visualization hint:\n<visualization_hint>\n${hint}\n</visualization_hint>`
                : "Choose the most useful geometric or graphical interpretation yourself."
            }`;
      const result = await modelRequest(
        requestId,
        {
          provider: workspaceRef.current.settings.provider,
          localBaseUrl: workspaceRef.current.settings.localBaseUrl,
          model: visualizationModel,
          reasoningEffort: compatibleReasoningEffort(
            workspaceRef.current.settings.provider,
            visualizationModel,
            workspaceRef.current.settings.visualizationReasoningEfforts[
              workspaceRef.current.settings.provider
            ],
          ),
          maxOutputTokens: workspaceRef.current.settings.maxOutputTokens,
          customInstructions: workspaceRef.current.settings.customInstructions,
          context: [
            {
              title: node.title,
              messages: [{ role: sourceMessage.role, content: sourceMessage.content }],
            },
          ],
          message: prompt,
          anchor: visualization.anchor,
          purpose: "visualization",
          visualizationEngine: engine,
        },
        () => undefined,
        () => undefined,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (result.stopped) {
        updateVisualization(chatId, nodeId, visualizationId, (current) => ({
          ...current,
          status: "error",
          errorStage: "model",
          errorMessage: "Visualization generation stopped.",
          requestId: undefined,
          generation: result.generation,
          updatedAt: timestamp(),
        }));
        return;
      }
      const source = extractVisualizationSource(result.content, engine);
      const compileError = await compileVisualization(
        chatId,
        nodeId,
        visualizationId,
        source,
        result.generation,
        engine,
      );
      if (compileError && followup?.kind !== "repair") {
        await generateVisualization(chatId, nodeId, visualizationId, hint, engine, {
          kind: "repair", source, diagnostic: compileError.log || compileError.message,
        });
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      updateVisualization(chatId, nodeId, visualizationId, (current) => ({
        ...current,
        status: "error",
        errorStage: "model",
        errorMessage: error instanceof Error ? error.message : "Visualization generation failed",
        requestId: undefined,
        generation: error instanceof GenerationStreamError ? error.generation : current.generation,
        updatedAt: timestamp(),
      }));
    } finally {
      if (responseControllers.current.get(visualizationId) === controller) {
        responseControllers.current.delete(visualizationId);
      }
    }
  };

  const reviseVisualization = async (
    chatId: string,
    nodeId: string,
    visualizationId: string,
    instruction: string,
  ): Promise<void> => {
    const visualization = workspaceRef.current.chats
      .find((chat) => chat.id === chatId)
      ?.nodes[nodeId]?.visualizations?.find((item) => item.id === visualizationId);
    const source = visualization ? visualizationSource(visualization).trim() : "";
    const revisionInstruction = instruction.trim();
    if (!visualization || !source || !revisionInstruction) return;
    await generateVisualization(
      chatId,
      nodeId,
      visualizationId,
      visualization.hint,
      visualizationEngine(visualization),
      {
      kind: "revision",
      source,
      instruction: revisionInstruction,
      },
    );
  };

  const stopVisualization = async (
    chatId: string,
    nodeId: string,
    visualizationId: string,
  ) => {
    const chat = workspaceRef.current.chats.find((item) => item.id === chatId);
    const visualization = chat?.nodes[nodeId]?.visualizations?.find(
      (item) => item.id === visualizationId,
    );
    if (visualization?.status !== "generating" || !visualization.requestId) return;
    try {
      const response = await fetch(
        `/api/respond/${encodeURIComponent(visualization.requestId)}/abort`,
        { method: "POST" },
      );
      const data = (await response.json().catch(() => ({}))) as ApiError & {
        generation?: GenerationMetrics;
      };
      if (!response.ok) throw new Error(data.error ?? "Could not stop visualization generation");
      responseControllers.current.get(visualizationId)?.abort();
      updateVisualization(chatId, nodeId, visualizationId, (current) => ({
        ...current,
        status: "error",
        errorStage: "model",
        errorMessage: "Visualization generation stopped.",
        requestId: undefined,
        generation: data.generation,
        updatedAt: timestamp(),
      }));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not stop visualization generation");
    }
  };

  const deleteVisualization = (chatId: string, nodeId: string, visualizationId: string) => {
    const chat = workspaceRef.current.chats.find((item) => item.id === chatId);
    const visualization = chat?.nodes[nodeId]?.visualizations?.find(
      (item) => item.id === visualizationId,
    );
    if (!chat || !visualization || visualization.status === "generating" || visualization.status === "compiling") return;
    if (!window.confirm("Delete this visualization?")) return;
    updateChat(chatId, (current) => {
      const currentNode = current.nodes[nodeId];
      if (!currentNode) return current;
      const updatedAt = timestamp();
      return {
        ...current,
        updatedAt,
        nodes: {
          ...current.nodes,
          [nodeId]: {
            ...currentNode,
            updatedAt,
            visualizations: (currentNode.visualizations ?? []).filter(
              (item) => item.id !== visualizationId,
            ),
          },
        },
      };
    });
  };

  const stopResponse = async (nodeId: string, assistantId: string) => {
    if (!activeChat) return;
    const node = activeChat.nodes[nodeId];
    const assistant = node ? assistantMessageById(node, assistantId) : undefined;
    if (!assistant?.requestId) {
      window.alert("This response predates resumable requests and cannot be stopped remotely.");
      return;
    }
    try {
      const response = await fetch(
        `/api/respond/${encodeURIComponent(assistant.requestId)}/abort`,
        { method: "POST" },
      );
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as ApiError;
        throw new Error(data.error ?? "The server could not stop this response");
      }
      const data = (await response.json()) as {
        stopped: boolean;
        generation: GenerationMetrics;
      };
      flushAssistantDeltas();
      responseControllers.current.get(assistantId)?.abort();
      markAssistantStopped(activeChat.id, nodeId, assistantId, data.generation);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "The response could not be stopped");
    }
  };

  const askMessageRevision = async (
    chat: ChatTree,
    nodeId: string,
    revisionGroupId: string,
    userMessage: Message,
    assistantMessage: Message,
    requestOptions?: {
      model?: string;
      reasoningEffort?: ReasoningEffort;
    },
  ) => {
    if (!assistantMessage.requestId) return;
    const controller = new AbortController();
    responseControllers.current.set(assistantMessage.id, controller);
    try {
      const result = await modelRequest(
        assistantMessage.requestId,
        {
          provider: workspace.settings.provider,
          localBaseUrl: workspace.settings.localBaseUrl,
          model: requestOptions?.model ?? workspace.settings.model,
          reasoningEffort:
            requestOptions?.reasoningEffort ?? workspace.settings.reasoningEffort,
          maxOutputTokens: workspace.settings.maxOutputTokens,
          customInstructions: workspace.settings.customInstructions,
          context: contextBeforeMessage(chat, nodeId, revisionGroupId),
          message: userMessage.content,
          anchor: chat.nodes[nodeId]?.anchor,
        },
        (delta) => appendAssistantDelta(chat.id, nodeId, assistantMessage.id, delta),
        (content) => replaceAssistantContent(chat.id, nodeId, assistantMessage.id, content),
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (result.stopped) {
        markAssistantStopped(
          chat.id,
          nodeId,
          assistantMessage.id,
          result.generation,
          result.content,
        );
      } else {
        finishAssistant(
          chat.id,
          nodeId,
          assistantMessage.id,
          result.content,
          false,
          result.generation,
        );
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      finishAssistant(
        chat.id,
        nodeId,
        assistantMessage.id,
        error instanceof Error ? error.message : "The request failed",
        true,
        error instanceof GenerationStreamError ? error.generation : undefined,
      );
    } finally {
      if (responseControllers.current.get(assistantMessage.id) === controller) {
        responseControllers.current.delete(assistantMessage.id);
      }
    }
  };

  const resumeGeneration = async (pending: PendingGeneration) => {
    const controller = new AbortController();
    responseControllers.current.set(pending.assistantId, controller);
    try {
      const result = await resumeModelRequest(
        pending.requestId,
        (delta) =>
          appendAssistantDelta(pending.chatId, pending.nodeId, pending.assistantId, delta),
        (content) =>
          replaceAssistantContent(pending.chatId, pending.nodeId, pending.assistantId, content),
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (result.stopped) {
        markAssistantStopped(
          pending.chatId,
          pending.nodeId,
          pending.assistantId,
          result.generation,
          result.content,
        );
      } else {
        finishAssistant(
          pending.chatId,
          pending.nodeId,
          pending.assistantId,
          result.content,
          false,
          result.generation,
        );
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      finishAssistant(
        pending.chatId,
        pending.nodeId,
        pending.assistantId,
        error instanceof Error ? error.message : "The request failed",
        true,
        error instanceof GenerationStreamError ? error.generation : undefined,
      );
    } finally {
      if (responseControllers.current.get(pending.assistantId) === controller) {
        responseControllers.current.delete(pending.assistantId);
      }
    }
  };

  const resumeDefinition = async (pending: PendingGeneration) => {
    const controller = new AbortController();
    responseControllers.current.set(pending.assistantId, controller);
    try {
      const result = await resumeModelRequest(
        pending.requestId,
        () => undefined,
        () => undefined,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const content = oneParagraph(result.content);
      updateDefinition(
        pending.chatId,
        pending.nodeId,
        pending.assistantId,
        (current) => ({
          ...current,
          content: content || "No definition was returned.",
          pending: false,
          error: result.stopped || !content,
          generation: result.generation,
        }),
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      updateDefinition(
        pending.chatId,
        pending.nodeId,
        pending.assistantId,
        (current) => ({
          ...current,
          content: error instanceof Error ? error.message : "The definition request failed",
          pending: false,
          error: true,
          generation:
            error instanceof GenerationStreamError ? error.generation : undefined,
        }),
      );
    } finally {
      if (responseControllers.current.get(pending.assistantId) === controller) {
        responseControllers.current.delete(pending.assistantId);
      }
    }
  };

  const resumeVisualization = async (pending: PendingGeneration) => {
    const visualization = workspaceRef.current.chats
      .find((chat) => chat.id === pending.chatId)
      ?.nodes[pending.nodeId]?.visualizations?.find(
        (item) => item.id === pending.assistantId,
      );
    const engine = visualizationEngine(visualization ?? { engine: undefined });
    const controller = new AbortController();
    responseControllers.current.set(pending.assistantId, controller);
    try {
      const result = await resumeModelRequest(
        pending.requestId,
        () => undefined,
        () => undefined,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (result.stopped) {
        updateVisualization(
          pending.chatId,
          pending.nodeId,
          pending.assistantId,
          (current) => ({
            ...current,
            status: "error",
            errorStage: "model",
            errorMessage: "Visualization generation stopped.",
            requestId: undefined,
            generation: result.generation,
            updatedAt: timestamp(),
          }),
        );
        return;
      }
      await compileVisualization(
        pending.chatId,
        pending.nodeId,
        pending.assistantId,
        extractVisualizationSource(result.content, engine),
        result.generation,
        engine,
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      updateVisualization(
        pending.chatId,
        pending.nodeId,
        pending.assistantId,
        (current) => ({
          ...current,
          status: "error",
          errorStage: "model",
          errorMessage: error instanceof Error ? error.message : "Visualization generation failed",
          requestId: undefined,
          generation: error instanceof GenerationStreamError ? error.generation : current.generation,
          updatedAt: timestamp(),
        }),
      );
    } finally {
      if (responseControllers.current.get(pending.assistantId) === controller) {
        responseControllers.current.delete(pending.assistantId);
      }
    }
  };

  useEffect(() => {
    if (!loaded) return;
    pendingGenerations(workspace).forEach((pending) => {
      if (!responseControllers.current.has(pending.assistantId)) {
        if (pending.kind === "definition") void resumeDefinition(pending);
        else if (pending.kind === "visualization") void resumeVisualization(pending);
        else void resumeGeneration(pending);
      }
    });
    workspace.chats.forEach((chat) => {
      Object.values(chat.nodes).forEach((node) => {
        (node.visualizations ?? []).forEach((visualization) => {
          const compileKey = `${chat.id}:${node.id}:${visualization.id}`;
          const source = visualizationSource(visualization);
          if (
            visualization.status === "compiling" &&
            source &&
            !visualizationCompiles.current.has(compileKey)
          ) {
            void compileVisualization(
              chat.id,
              node.id,
              visualization.id,
              source,
              visualization.generation,
              visualizationEngine(visualization),
            );
          }
        });
      });
    });
  }, [loaded, workspace.chats]);

  const editUserMessage = (nodeId: string, revisionGroupId: string, content: string) => {
    if (!activeChat) return;
    const node = activeChat.nodes[nodeId];
    if (!node) return;
    const userIndex = node.messages.findIndex(
      (message) => message.id === revisionGroupId && message.role === "user",
    );
    const originalUser = node.messages[userIndex];
    const originalAssistant = node.messages[userIndex + 1];
    if (!originalUser || originalAssistant?.role !== "assistant") return;

    const existingGroup = node.messageRevisions?.[revisionGroupId];
    const baseVariantId = newId();
    const baseVariants = existingGroup?.variants ?? [
      {
        id: baseVariantId,
        userMessage: { ...originalUser },
        assistantMessage: { ...originalAssistant },
      },
    ];
    const revisionId = newId();
    const userMessage = makeMessage("user", content);
    const assistantMessage = makePendingAssistant();
    const group: MessageRevisionGroup = {
      userMessageId: revisionGroupId,
      assistantMessageId: originalAssistant.id,
      activeVariantId: revisionId,
      variants: [
        ...baseVariants,
        { id: revisionId, userMessage, assistantMessage },
      ],
    };
    const updatedAt = timestamp();
    const nextChat: ChatTree = {
      ...activeChat,
      updatedAt,
      nodes: {
        ...activeChat.nodes,
        [nodeId]: {
          ...node,
          updatedAt,
          messageRevisions: {
            ...node.messageRevisions,
            [revisionGroupId]: group,
          },
        },
      },
    };
    setWorkspace((current) => ({
      ...current,
      chats: current.chats.map((chat) => (chat.id === nextChat.id ? nextChat : chat)),
    }));
    void askMessageRevision(
      nextChat,
      nodeId,
      revisionGroupId,
      userMessage,
      assistantMessage,
    );
  };

  const regenerateAssistantMessage = (
    nodeId: string,
    assistantId: string,
    modelOverride?: string,
    reasoningEffortOverride?: ReasoningEffort,
  ) => {
    if (!activeChat) return;
    const node = activeChat.nodes[nodeId];
    if (
      !node ||
      messagesForNode(node).some(
        (message) => message.role === "assistant" && message.pending,
      )
    ) {
      return;
    }

    const existingResponseEntry = Object.entries(node.responseRevisions ?? {}).find(
      ([, group]) => group.responses.some((response) => response.id === assistantId),
    );
    const existingResponseGroup = existingResponseEntry?.[1];
    const baseAssistantId = existingResponseGroup?.assistantMessageId ?? assistantId;
    const baseAssistant =
      existingResponseGroup?.responses.find(
        (response) => response.id === baseAssistantId,
      ) ?? assistantMessageById(node, baseAssistantId);
    if (!baseAssistant || baseAssistant.role !== "assistant") return;

    const messageRevisionEntry = Object.entries(node.messageRevisions ?? {}).find(
      ([, group]) =>
        group.variants.some(
          (variant) => variant.assistantMessage.id === baseAssistantId,
        ),
    );
    const messageVariant = messageRevisionEntry?.[1].variants.find(
      (variant) => variant.assistantMessage.id === baseAssistantId,
    );

    let revisionGroupId = messageRevisionEntry?.[0];
    let userMessage = messageVariant?.userMessage;
    if (!revisionGroupId || !userMessage) {
      const assistantIndex = node.messages.findIndex(
        (message) => message.id === baseAssistantId && message.role === "assistant",
      );
      const candidateUser = node.messages[assistantIndex - 1];
      if (
        assistantIndex < 1 ||
        candidateUser?.role !== "user"
      ) {
        return;
      }
      revisionGroupId = candidateUser.id;
      userMessage = candidateUser;
    }

    const assistantMessage = makePendingAssistant();
    const responseGroup: ResponseRevisionGroup = {
      assistantMessageId: baseAssistantId,
      activeResponseId: assistantMessage.id,
      responses: [
        ...(existingResponseGroup?.responses ?? [baseAssistant]),
        assistantMessage,
      ],
    };
    const updatedAt = timestamp();
    const nextChat: ChatTree = {
      ...activeChat,
      updatedAt,
      nodes: {
        ...activeChat.nodes,
        [nodeId]: {
          ...node,
          updatedAt,
          responseRevisions: {
            ...node.responseRevisions,
            [baseAssistantId]: responseGroup,
          },
        },
      },
    };
    setWorkspace((current) => ({
      ...current,
      chats: current.chats.map((chat) => (chat.id === nextChat.id ? nextChat : chat)),
    }));
    void askMessageRevision(
      nextChat,
      nodeId,
      revisionGroupId,
      userMessage,
      assistantMessage,
      modelOverride || reasoningEffortOverride
        ? {
            model: modelOverride ?? workspace.settings.model,
            reasoningEffort: compatibleReasoningEffort(
              workspace.settings.provider,
              modelOverride ?? workspace.settings.model,
              reasoningEffortOverride ?? workspace.settings.reasoningEffort,
            ),
          }
        : undefined,
    );
  };

  const switchMessageRevision = (
    nodeId: string,
    revisionGroupId: string,
    variantId: string,
  ) => {
    if (!activeChat) return;
    updateChat(activeChat.id, (chat) => {
      const node = chat.nodes[nodeId];
      const group = node?.messageRevisions?.[revisionGroupId];
      if (!node || !group || !group.variants.some((variant) => variant.id === variantId)) {
        return chat;
      }
      return {
        ...chat,
        updatedAt: timestamp(),
        nodes: {
          ...chat.nodes,
          [nodeId]: {
            ...node,
            messageRevisions: {
              ...node.messageRevisions,
              [revisionGroupId]: { ...group, activeVariantId: variantId },
            },
          },
        },
      };
    });
  };

  const switchResponseRevision = (
    nodeId: string,
    responseGroupId: string,
    responseId: string,
  ) => {
    if (!activeChat) return;
    updateChat(activeChat.id, (chat) => {
      const node = chat.nodes[nodeId];
      const group = node?.responseRevisions?.[responseGroupId];
      if (!node || !group || !group.responses.some((response) => response.id === responseId)) {
        return chat;
      }
      return {
        ...chat,
        updatedAt: timestamp(),
        nodes: {
          ...chat.nodes,
          [nodeId]: {
            ...node,
            responseRevisions: {
              ...node.responseRevisions,
              [responseGroupId]: { ...group, activeResponseId: responseId },
            },
          },
        },
      };
    });
  };

  const createChat = (
    mode: "ask" | "import",
    content: string,
    suppliedTitle: string,
    categoryId: string | null,
  ) => {
    historyAction.current = "push";
    const createdAt = timestamp();
    const rootId = newId();
    const chatId = newId();
    const userMessage = makeMessage(mode === "import" ? "source" : "user", content);
    const assistantMessage =
      mode === "ask"
        ? makePendingAssistant()
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
      categoryId,
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
    if (assistantMessage) {
      void askModel(
        chat,
        rootId,
        userMessage,
        assistantMessage.id,
        assistantMessage.requestId,
      );
    }
  };

  const sendToThread = (nodeId: string, content: string) => {
    if (!activeChat) return;
    const node = activeChat.nodes[nodeId];
    if (!node) return;
    const userMessage = makeMessage("user", content);
    const assistantMessage = makePendingAssistant();
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
    void askModel(
      nextChat,
      nodeId,
      userMessage,
      assistantMessage.id,
      assistantMessage.requestId,
      node.anchor,
    );
  };

  const beginElaboration = (request: string) => {
    if (!activeChat || !draft) return;
    historyAction.current = "push";
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
    const assistantMessage = makePendingAssistant();
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
    draftReturnView.current = null;
    setDraft(null);
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    void askModel(
      nextChat,
      childId,
      userMessage,
      assistantMessage.id,
      assistantMessage.requestId,
      anchor,
    );
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

  const openRenameNode = (nodeId: string, navigateToNode = true) => {
    if (!activeChat) return;
    const node = activeChat.nodes[nodeId];
    if (!node) return;
    setRenameDraft(node.title);
    setRenamingNodeId(nodeId);
    setChatMenuOpen(false);
    setBranchMenuOpen(false);
    if (navigateToNode && nodeId !== activeChat.rootId) {
      historyAction.current = "push";
      setActiveNodeId(nodeId);
      setFocusMaximized(false);
    }
  };

  const saveNodeName = () => {
    if (!activeChat || !renamingNodeId) return;
    const title = renameDraft.trim();
    if (!title) return;
    const updatedAt = timestamp();
    updateChat(activeChat.id, (chat) => ({
      ...chat,
      title: renamingNodeId === chat.rootId ? title : chat.title,
      updatedAt,
      nodes: {
        ...chat.nodes,
        [renamingNodeId]: { ...chat.nodes[renamingNodeId], title, updatedAt },
      },
    }));
    setRenamingNodeId(null);
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

  const saveCategory = () => {
    if (!categoryEditor) return;
    const name = categoryEditor.name.trim();
    if (!name) return;
    if (
      workspace.categories.some(
        (category) =>
          category.id !== categoryEditor.categoryId &&
          category.name.trim().toLowerCase() === name.toLowerCase(),
      )
    ) {
      return;
    }
    const updatedAt = timestamp();
    setWorkspace((current) => {
      const duplicate = current.categories.some(
        (category) =>
          category.id !== categoryEditor.categoryId &&
          category.name.trim().toLowerCase() === name.toLowerCase(),
      );
      if (duplicate) return current;
      if (categoryEditor.categoryId) {
        return {
          ...current,
          categories: current.categories.map((category) =>
            category.id === categoryEditor.categoryId
              ? { ...category, name, updatedAt }
              : category,
          ),
        };
      }
      const category: ChatCategory = {
        id: newId(),
        name,
        createdAt: updatedAt,
        updatedAt,
      };
      return { ...current, categories: [...current.categories, category] };
    });
    setCategoryEditor(null);
    setCategoryMenuId(null);
  };

  const moveCategory = (categoryId: string, direction: -1 | 1) => {
    setWorkspace((current) => {
      const index = current.categories.findIndex((category) => category.id === categoryId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.categories.length) return current;
      const categories = [...current.categories];
      [categories[index], categories[target]] = [categories[target], categories[index]];
      return { ...current, categories };
    });
    setCategoryMenuId(null);
  };

  const deleteCategory = (category: ChatCategory) => {
    const count = workspace.chats.filter((chat) => chat.categoryId === category.id).length;
    const detail = count
      ? ` ${count} ${count === 1 ? "chat" : "chats"} will become uncategorized.`
      : "";
    if (!window.confirm(`Delete the “${category.name}” category?${detail}`)) return;
    setWorkspace((current) => ({
      ...current,
      categories: current.categories.filter((candidate) => candidate.id !== category.id),
      chats: current.chats.map((chat) =>
        chat.categoryId === category.id ? { ...chat, categoryId: null } : chat,
      ),
      settings: {
        ...current.settings,
        collapsedCategoryIds: current.settings.collapsedCategoryIds.filter(
          (id) => id !== category.id,
        ),
      },
    }));
    setCategoryMenuId(null);
  };

  const moveActiveChat = (categoryId: string) => {
    if (!activeChat) return;
    updateChat(activeChat.id, (chat) => ({
      ...chat,
      categoryId: categoryId || null,
      updatedAt: timestamp(),
    }));
    setChatMenuOpen(false);
  };

  const exportAllChats = () => {
    downloadChatExport(makeChatExport(workspace, { type: "all" }), "locus-all-chats");
  };

  const exportCategory = (category: ChatCategory) => {
    downloadChatExport(
      makeChatExport(workspace, {
        type: "category",
        categoryId: category.id,
        name: category.name,
      }),
      `locus-${category.name}`,
    );
    setCategoryMenuId(null);
  };

  const exportUncategorized = () => {
    downloadChatExport(
      makeChatExport(workspace, {
        type: "category",
        categoryId: null,
        name: "Uncategorized",
      }),
      "locus-uncategorized",
    );
    setCategoryMenuId(null);
  };

  const toggleCategoryCollapse = (categoryId: string) => {
    setWorkspace((current) => {
      const collapsed = current.settings.collapsedCategoryIds.includes(categoryId);
      return {
        ...current,
        settings: {
          ...current.settings,
          collapsedCategoryIds: collapsed
            ? current.settings.collapsedCategoryIds.filter((id) => id !== categoryId)
            : [...current.settings.collapsedCategoryIds, categoryId],
        },
      };
    });
    setCategoryMenuId(null);
  };

  const exportActiveChat = () => {
    if (!activeChat) return;
    downloadChatExport(
      makeChatExport(workspace, {
        type: "chat",
        chatId: activeChat.id,
        title: activeChat.title,
      }),
      `locus-${activeChat.title}`,
    );
    setChatMenuOpen(false);
  };

  const resetJsonImport = () => {
    setJsonImportOpen(false);
    setJsonImport(null);
    setJsonImportFilename("");
    setJsonImportError("");
    setJsonImportTarget("uncategorized");
    setJsonImportNewCategory("");
  };

  const readJsonImportFile = async (file: File | undefined) => {
    setJsonImport(null);
    setJsonImportFilename(file?.name ?? "");
    setJsonImportError("");
    if (!file) return;
    try {
      const parsed = parseChatImport(await file.text());
      setJsonImport(parsed);
      setJsonImportTarget(parsed.categories.length ? "preserve" : "uncategorized");
    } catch (error) {
      setJsonImportError(
        error instanceof Error ? error.message : "The JSON file could not be read.",
      );
    }
  };

  const importJsonChats = () => {
    if (!jsonImport) return;
    if (jsonImportTarget === "new" && !jsonImportNewCategory.trim()) return;
    const importedChats = jsonImport.chats.map((chat) => cloneChatForImport(chat, newId()));
    const firstChat = importedChats[0] ?? null;
    setWorkspace((current) => {
      let categories = [...current.categories];
      let commonCategoryId: string | null = null;
      const categoryMap = new Map<string, string>();

      if (jsonImportTarget === "new") {
        const name = jsonImportNewCategory.trim();
        const existing = categories.find(
          (category) => category.name.trim().toLowerCase() === name.toLowerCase(),
        );
        if (existing) {
          commonCategoryId = existing.id;
        } else {
          const createdAt = timestamp();
          const category: ChatCategory = {
            id: newId(),
            name,
            createdAt,
            updatedAt: createdAt,
          };
          categories.push(category);
          commonCategoryId = category.id;
        }
      } else if (jsonImportTarget === "uncategorized") {
        commonCategoryId = null;
      } else if (jsonImportTarget === "preserve") {
        jsonImport.categories.forEach((importedCategory) => {
          const existing = categories.find(
            (category) =>
              category.name.trim().toLowerCase() ===
              importedCategory.name.trim().toLowerCase(),
          );
          if (existing) {
            categoryMap.set(importedCategory.id, existing.id);
            return;
          }
          const category = { ...importedCategory, id: newId() };
          categories.push(category);
          categoryMap.set(importedCategory.id, category.id);
        });
      } else if (categories.some((category) => category.id === jsonImportTarget)) {
        commonCategoryId = jsonImportTarget;
      }

      const chats = importedChats.map((chat, index) => ({
        ...chat,
        categoryId:
          jsonImportTarget === "preserve"
            ? chat.categoryId
              ? categoryMap.get(chat.categoryId) ?? null
              : null
            : commonCategoryId,
        // Preserve export ordering while making equal timestamps deterministic in the sidebar.
        updatedAt: chat.updatedAt || new Date(Date.now() - index).toISOString(),
      }));
      return {
        ...current,
        categories,
        activeChatId: firstChat?.id ?? current.activeChatId,
        chats: [...chats, ...current.chats],
      };
    });

    if (firstChat) {
      historyAction.current = "push";
      setActiveNodeId(firstChat.rootId);
      setDraft(null);
      setSelection(null);
      setFocusMaximized(false);
      setSidebarOpen(false);
    }
    setSearch("");
    resetJsonImport();
  };

  const deleteActiveChat = () => {
    if (!activeChat || !window.confirm(`Delete “${activeChat.title}”?`)) return;
    historyAction.current = "push";
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
    setRenamingNodeId(null);
    setFocusMaximized(false);
  };

  const filteredChats = useMemo(() => {
    const query = search.trim().toLowerCase();
    return workspace.chats
      .filter((chat) => !query || chat.title.toLowerCase().includes(query))
      .sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)));
  }, [search, workspace.chats]);

  const chatsByCategory = useMemo(() => {
    const grouped = new Map<string, ChatTree[]>();
    workspace.categories.forEach((category) => grouped.set(category.id, []));
    const uncategorized: ChatTree[] = [];
    filteredChats.forEach((chat) => {
      const group = chat.categoryId ? grouped.get(chat.categoryId) : null;
      if (group) group.push(chat);
      else uncategorized.push(chat);
    });
    return { grouped, uncategorized };
  }, [filteredChats, workspace.categories]);

  const openChat = (chat: ChatTree) => {
    historyAction.current = "push";
    setWorkspace((current) => ({ ...current, activeChatId: chat.id }));
    setActiveNodeId(chat.rootId);
    setDraft(null);
    setSelection(null);
    setSidebarOpen(false);
    setChatMenuOpen(false);
    setBranchMenuOpen(false);
    setRenamingNodeId(null);
    setCategoryMenuId(null);
    setFocusMaximized(false);
  };

  const startNew = (mode: "ask" | "import") => {
    historyAction.current = "push";
    setNewMode(mode);
    setWorkspace((current) => ({ ...current, activeChatId: null }));
    setActiveNodeId(null);
    setDraft(null);
    setSidebarOpen(false);
    setChatMenuOpen(false);
    setBranchMenuOpen(false);
    setRenamingNodeId(null);
    setCategoryMenuId(null);
    setFocusMaximized(false);
  };

  const openSidebar = () => {
    if (window.matchMedia("(min-width: 1021px)").matches) {
      setWorkspace((current) => ({
        ...current,
        settings: { ...current.settings, sidebarCollapsed: false },
      }));
      return;
    }
    setSidebarOpen(true);
  };

  const collapseSidebar = () => {
    setSidebarOpen(false);
    setWorkspace((current) => ({
      ...current,
      settings: { ...current.settings, sidebarCollapsed: true },
    }));
  };

  const selectModel = (model: string) => {
    setWorkspace((current) => {
      const reasoningEffort =
        current.settings.provider === "openai" &&
        current.settings.reasoningEffort === "max" &&
        !model.startsWith("gpt-5.6")
          ? "xhigh"
          : current.settings.reasoningEffort;
      return {
        ...current,
        settings: {
          ...current.settings,
          model,
          reasoningEffort,
          providerModels: {
            ...current.settings.providerModels,
            [current.settings.provider]: model,
          },
        },
      };
    });
  };

  const selectDefinitionModel = (model: string) => {
    setWorkspace((current) => ({
      ...current,
      settings: {
        ...current.settings,
        definitionModels: {
          ...current.settings.definitionModels,
          [current.settings.provider]: model,
        },
      },
    }));
  };

  const selectVisualizationModel = (model: string) => {
    setWorkspace((current) => {
      const provider = current.settings.provider;
      return {
        ...current,
        settings: {
          ...current.settings,
          visualizationModels: {
            ...current.settings.visualizationModels,
            [provider]: model,
          },
          visualizationReasoningEfforts: {
            ...current.settings.visualizationReasoningEfforts,
            [provider]: compatibleReasoningEffort(
              provider,
              model,
              current.settings.visualizationReasoningEfforts[provider],
            ),
          },
        },
      };
    });
  };

  const selectVisualizationReasoningEffort = (reasoningEffort: ReasoningEffort) => {
    setWorkspace((current) => ({
      ...current,
      settings: {
        ...current.settings,
        visualizationReasoningEfforts: {
          ...current.settings.visualizationReasoningEfforts,
          [current.settings.provider]: reasoningEffort,
        },
      },
    }));
  };

  const selectProvider = (provider: ProviderId) => {
    setWorkspace((current) => {
      const providerModels = {
        ...current.settings.providerModels,
        [current.settings.provider]: current.settings.model,
      };
      const model = providerModels[provider] || DEFAULT_PROVIDER_MODELS[provider];
      const reasoningEffort =
        provider === "openai" &&
        current.settings.reasoningEffort === "max" &&
        !model.startsWith("gpt-5.6")
          ? "xhigh"
          : current.settings.reasoningEffort;
      return {
        ...current,
        settings: {
          ...current.settings,
          provider,
          providerModels,
          model,
          reasoningEffort,
        },
      };
    });
  };

  const selectReasoningEffort = (reasoningEffort: ReasoningEffort) => {
    setWorkspace((current) => ({
      ...current,
      settings: { ...current.settings, reasoningEffort },
    }));
  };

  const toggleTheme = () => {
    setWorkspace((current) => ({
      ...current,
      settings: {
        ...current.settings,
        theme: current.settings.theme === "dark" ? "light" : "dark",
      },
    }));
  };

  const closeApiKeyModal = () => {
    setApiKeyOpen(false);
    setApiKeyDraft("");
    setApiKeyError("");
  };

  const savePastedApiKey = async () => {
    setApiKeySaving(true);
    setApiKeyError("");
    try {
      const response = await fetch(`/api/providers/${credentialProvider}/api-key`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: apiKeyDraft }),
      });
      const result = (await response.json()) as ProviderCredentialStatus & ApiError;
      if (!response.ok) throw new Error(result.error || "Could not save the API key");
      setProviderStatuses((current) =>
        current ? { ...current, [credentialProvider]: result } : current,
      );
      closeApiKeyModal();
    } catch (error) {
      setApiKeyError(error instanceof Error ? error.message : "Could not save the API key");
    } finally {
      setApiKeySaving(false);
    }
  };

  const clearSavedApiKey = async () => {
    setApiKeySaving(true);
    setApiKeyError("");
    try {
      const response = await fetch(`/api/providers/${credentialProvider}/api-key`, {
        method: "DELETE",
      });
      const result = (await response.json()) as ProviderCredentialStatus & ApiError;
      if (!response.ok) throw new Error(result.error || "Could not clear the API key");
      setProviderStatuses((current) =>
        current ? { ...current, [credentialProvider]: result } : current,
      );
      closeApiKeyModal();
    } catch (error) {
      setApiKeyError(error instanceof Error ? error.message : "Could not clear the API key");
    } finally {
      setApiKeySaving(false);
    }
  };

  const applyComposerInsertion = (id: string) => {
    setComposerInsertion((current) => (current?.id === id ? null : current));
  };

  const quoteSelectionInThread = () => {
    if (!selection) return;
    setComposerInsertion({
      id: newId(),
      nodeId: selection.sourceNodeId,
      value: markdownBlockquote(selection.quote),
    });
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  };

  const visualizeSelection = () => {
    if (!activeChat || !selection) return;
    const node = activeChat.nodes[selection.sourceNodeId];
    if (!node) return;
    const matchesSelection = (visualization: InlineVisualization) =>
      visualization.anchor.sourceMessageId === selection.sourceMessageId &&
      visualization.anchor.blockIndex === selection.blockIndex &&
      visualization.anchor.quote === selection.quote;
    const existing = (node.visualizations ?? []).find(matchesSelection);
    window.getSelection()?.removeAllRanges();
    setSelection(null);
    if (existing) {
      window.requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(`[data-visualization-id="${CSS.escape(existing.id)}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      return;
    }

    const createdAt = timestamp();
    const visualization: InlineVisualization = {
      id: newId(),
      anchor: {
        sourceNodeId: selection.sourceNodeId,
        sourceMessageId: selection.sourceMessageId,
        quote: selection.quote,
        blockIndex: selection.blockIndex,
      },
      hint: "",
      status: "draft",
      engine: "metapost",
      createdAt,
      updatedAt: createdAt,
    };
    setWorkspace((current) => ({
      ...current,
      chats: current.chats.map((chat) =>
        chat.id !== activeChat.id
          ? chat
          : (() => {
              const currentNode = chat.nodes[node.id] ?? node;
              return {
              ...chat,
              updatedAt: createdAt,
              nodes: {
                ...chat.nodes,
                [node.id]: {
                  ...currentNode,
                  updatedAt: createdAt,
                  visualizations: [...(currentNode.visualizations ?? []), visualization],
                },
              },
            };
          })(),
      ),
    }));
  };

  const defineSelection = () => {
    if (!activeChat || !selection) return;
    const node = activeChat.nodes[selection.sourceNodeId];
    if (!node) return;
    const liveSelection = window.getSelection();
    const selectedRange =
      liveSelection?.rangeCount && !liveSelection.isCollapsed
        ? liveSelection.getRangeAt(0).cloneRange()
        : null;
    const getAnchorRect = selectedRange
      ? () => selectedRange.getBoundingClientRect()
      : undefined;
    const clearNativeSelectionAfterHighlight = () => {
      if (!selectedRange) return;
      window.requestAnimationFrame(() => {
        const current = window.getSelection();
        if (!current?.rangeCount) return;
        const range = current.getRangeAt(0);
        if (
          range.startContainer === selectedRange.startContainer &&
          range.startOffset === selectedRange.startOffset &&
          range.endContainer === selectedRange.endContainer &&
          range.endOffset === selectedRange.endOffset
        ) {
          current.removeAllRanges();
        }
      });
    };
    const matchesSelection = (definition: InlineDefinition) =>
        definition.anchor.sourceMessageId === selection.sourceMessageId &&
        definition.anchor.blockIndex === selection.blockIndex &&
        definition.anchor.quote === selection.quote;
    const existing = (node.definitions ?? []).find(
      (definition) => !definition.error && matchesSelection(definition),
    );
    if (existing) {
      setDefinitionPopover({
        chatId: activeChat.id,
        nodeId: node.id,
        definitionId: existing.id,
        rect: selection.rect,
        getAnchorRect,
      });
      setSelection(null);
      clearNativeSelectionAfterHighlight();
      return;
    }

    const createdAt = timestamp();
    const definition: InlineDefinition = {
      id: newId(),
      anchor: {
        sourceNodeId: selection.sourceNodeId,
        sourceMessageId: selection.sourceMessageId,
        quote: selection.quote,
        blockIndex: selection.blockIndex,
      },
      content: "",
      createdAt,
      pending: true,
      requestId: newId(),
    };
    const nextChat: ChatTree = {
      ...activeChat,
      updatedAt: createdAt,
      nodes: {
        ...activeChat.nodes,
        [node.id]: {
          ...node,
          updatedAt: createdAt,
          definitions: [
            ...(node.definitions ?? []).filter(
              (current) => !current.error || !matchesSelection(current),
            ),
            definition,
          ],
        },
      },
    };
    setWorkspace((current) => ({
      ...current,
      chats: current.chats.map((chat) =>
        chat.id === nextChat.id ? nextChat : chat,
      ),
    }));
    setDefinitionPopover({
      chatId: activeChat.id,
      nodeId: node.id,
      definitionId: definition.id,
      rect: selection.rect,
      getAnchorRect,
    });
    setSelection(null);
    clearNativeSelectionAfterHighlight();
    void askDefinition(nextChat, node.id, definition);
  };

  if (!loaded) {
    return (
      <div className="loading-screen">
        <div className="brand-mark"><GitBranch size={20} /></div>
        <span>Opening your workspace…</span>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="loading-screen loading-screen--error">
        <div className="brand-mark"><GitBranch size={20} /></div>
        <strong>Could not open your workspace</strong>
        <span>{loadError}</span>
        <button type="button" onClick={() => window.location.reload()}>Retry</button>
      </div>
    );
  }

  const drawerOpen = Boolean(activeChat && (draft || sideNode));
  const availableProviders = runtime.localProviderEnabled
    ? PROVIDER_OPTIONS
    : PROVIDER_OPTIONS.filter((provider) => provider.id !== "local");
  const activeBranchCount = activeChat ? Object.keys(activeChat.nodes).length - 1 : 0;
  const activePath = activeChat && sideNode ? threadPath(activeChat, sideNode.id) : [];
  const draftPath = activeChat && draft ? threadPath(activeChat, draft.sourceNodeId) : [];
  const leftPanePath = activeChat && leftPaneNode ? threadPath(activeChat, leftPaneNode.id) : [];
  const leftPaneIsRoot = Boolean(
    activeChat && leftPaneNode && leftPaneNode.id === activeChat.rootId,
  );
  const displayedDefinition =
    definitionPopover && activeChat?.id === definitionPopover.chatId
      ? activeChat.nodes[definitionPopover.nodeId]?.definitions?.find(
          (definition) => definition.id === definitionPopover.definitionId,
        ) ?? null
      : null;
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
  const renderChatRow = (chat: ChatTree) => {
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
          <strong><InlineMath source={chat.title} /></strong>
          <small>
            {branchCount
              ? `${branchCount} elaboration${branchCount === 1 ? "" : "s"}`
              : "Main thread only"}
          </small>
        </span>
        {branchCount > 0 && <em>{treeDepth(chat)}</em>}
      </button>
    );
  };
  const uncategorizedCollapsed =
    !search &&
    workspace.settings.collapsedCategoryIds.includes(UNCATEGORIZED_CATEGORY_ID);

  return (
    <div
      className={`app-shell ${workspace.settings.sidebarCollapsed ? "app-shell--sidebar-collapsed" : ""} ${drawerOpen ? "app-shell--drawer" : ""} ${focusMaximized && sideNode ? "app-shell--focus-maximized" : ""}`}
      data-theme={workspace.settings.theme}
      style={
        {
          "--focus-drawer-width": `${drawerWidth}px`,
          "--text-scale": workspace.settings.textScale / 100,
        } as CSSProperties
      }
    >
      <aside className={`sidebar ${sidebarOpen ? "sidebar--open" : ""}`}>
        {categoryMenuId && (
          <button
            className="category-menu-scrim"
            type="button"
            aria-label="Close category menu"
            onClick={() => setCategoryMenuId(null)}
          />
        )}
        <div className="sidebar__top">
          <div className="brand">
            <div className="brand-mark"><GitBranch size={18} /></div>
            <span>Locus</span>
            <small>{runtime.mode === "hosted" ? "CLOUD" : "LOCAL"}</small>
            <button
              className="sidebar-collapse-button"
              type="button"
              title="Collapse sidebar"
              aria-label="Collapse studies sidebar"
              onClick={collapseSidebar}
            >
              <PanelLeftClose size={15} />
            </button>
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
          <div className="list-heading">
            <p className="list-label">Studies</p>
            <button
              type="button"
              aria-label="Create category"
              title="Create category"
              onClick={() => setCategoryEditor({ categoryId: null, name: "" })}
            >
              <Plus size={13} /> Category
            </button>
          </div>
          {search && !filteredChats.length ? (
            <p className="empty-list">No matching studies</p>
          ) : (
            <>
              {workspace.categories.map((category, categoryIndex) => {
                const chats = chatsByCategory.grouped.get(category.id) ?? [];
                if (search && !chats.length) return null;
                const collapsed =
                  !search && workspace.settings.collapsedCategoryIds.includes(category.id);
                return (
                  <section
                    className={`category-group ${collapsed ? "category-group--collapsed" : ""}`}
                    key={category.id}
                  >
                    <header className="category-header">
                      <button
                        className="category-toggle"
                        type="button"
                        aria-expanded={!collapsed}
                        aria-label={`${collapsed ? "Expand" : "Collapse"} ${category.name}`}
                        onClick={() => toggleCategoryCollapse(category.id)}
                      >
                        <ChevronRight
                          className={`category-chevron ${collapsed ? "" : "category-chevron--open"}`}
                          size={12}
                        />
                        <Folder size={13} />
                        <strong>{category.name}</strong>
                        <span>{chats.length}</span>
                      </button>
                      <button
                        className="category-options-button"
                        type="button"
                        aria-label={`Options for ${category.name}`}
                        aria-haspopup="true"
                        aria-expanded={categoryMenuId === category.id}
                        onClick={() =>
                          setCategoryMenuId((open) =>
                            open === category.id ? null : category.id,
                          )
                        }
                      >
                        <MoreHorizontal size={14} />
                      </button>
                    </header>
                    {categoryMenuId === category.id && (
                      <div className="category-menu" aria-label={`${category.name} options`}>
                        <button
                          type="button"
                          onClick={() =>
                            setCategoryEditor({
                              categoryId: category.id,
                              name: category.name,
                            })
                          }
                        >
                          <Pencil size={14} /> Rename
                        </button>
                        <button
                          type="button"
                          disabled={categoryIndex === 0}
                          onClick={() => moveCategory(category.id, -1)}
                        >
                          <ArrowUp size={14} /> Move up
                        </button>
                        <button
                          type="button"
                          disabled={categoryIndex === workspace.categories.length - 1}
                          onClick={() => moveCategory(category.id, 1)}
                        >
                          <ArrowDown size={14} /> Move down
                        </button>
                        <button type="button" onClick={() => exportCategory(category)}>
                          <Download size={14} /> Export category
                        </button>
                        <div />
                        <button
                          className="category-menu__danger"
                          type="button"
                          onClick={() => deleteCategory(category)}
                        >
                          <Trash2 size={14} /> Delete category
                        </button>
                      </div>
                    )}
                    {!collapsed && (
                      <div className="category-chats">
                        {chats.length ? (
                          chats.map(renderChatRow)
                        ) : (
                          <p className="category-empty">No chats</p>
                        )}
                      </div>
                    )}
                  </section>
                );
              })}
              {(!search || chatsByCategory.uncategorized.length > 0) && (
                <section
                  className={`category-group category-group--uncategorized ${uncategorizedCollapsed ? "category-group--collapsed" : ""}`}
                >
                  <header className="category-header">
                    <button
                      className="category-toggle"
                      type="button"
                      aria-expanded={!uncategorizedCollapsed}
                      aria-label={`${uncategorizedCollapsed ? "Expand" : "Collapse"} Uncategorized`}
                      onClick={() => toggleCategoryCollapse(UNCATEGORIZED_CATEGORY_ID)}
                    >
                      <ChevronRight
                        className={`category-chevron ${uncategorizedCollapsed ? "" : "category-chevron--open"}`}
                        size={12}
                      />
                      <Folder size={13} />
                      <strong>Uncategorized</strong>
                      <span>{chatsByCategory.uncategorized.length}</span>
                    </button>
                    <button
                      className="category-options-button"
                      type="button"
                      aria-label="Options for Uncategorized"
                      aria-haspopup="true"
                      aria-expanded={categoryMenuId === UNCATEGORIZED_CATEGORY_ID}
                      onClick={() =>
                        setCategoryMenuId((open) =>
                          open === UNCATEGORIZED_CATEGORY_ID
                            ? null
                            : UNCATEGORIZED_CATEGORY_ID,
                        )
                      }
                    >
                      <MoreHorizontal size={14} />
                    </button>
                  </header>
                  {categoryMenuId === UNCATEGORIZED_CATEGORY_ID && (
                    <div className="category-menu" aria-label="Uncategorized options">
                      <button
                        type="button"
                        disabled={!chatsByCategory.uncategorized.length}
                        onClick={exportUncategorized}
                      >
                        <Download size={14} /> Export category
                      </button>
                    </div>
                  )}
                  {!uncategorizedCollapsed && (
                    <div className="category-chats">
                      {chatsByCategory.uncategorized.length ? (
                        chatsByCategory.uncategorized.map(renderChatRow)
                      ) : (
                        <p className="category-empty">Your uncategorized chats will appear here.</p>
                      )}
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </div>

        <div className="sidebar__footer">
          <button
            className="settings-launcher"
            type="button"
            onClick={() => {
              setSettingsOpen(true);
              setSidebarOpen(false);
            }}
          >
            <Settings2 size={16} />
            <span>
              <strong>Settings</strong>
              <small>Workspace preferences</small>
            </span>
            <ChevronRight size={14} />
          </button>
          <button
            className="theme-toggle-button sidebar-theme-toggle"
            type="button"
            aria-label={
              workspace.settings.theme === "dark" ? "Use light mode" : "Use dark mode"
            }
            aria-pressed={workspace.settings.theme === "dark"}
            onClick={toggleTheme}
          >
            {workspace.settings.theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
            <span>
              <small>Appearance</small>
              <strong>
                {workspace.settings.theme === "dark" ? "Dark mode" : "Light mode"}
              </strong>
            </span>
            <i className="theme-switch" aria-hidden="true"><span /></i>
          </button>
          <div className={`save-status save-status--${saveState}`}>
            <i />
            {saveState === "saved"
              ? runtime.mode === "hosted" ? "Saved securely" : "Saved locally"
              : saveState === "saving"
                ? "Saving…"
                : "Save failed"}
          </div>
        </div>
      </aside>

      {sidebarOpen && <button className="sidebar-scrim" type="button" aria-label="Close menu" onClick={() => setSidebarOpen(false)} />}

      {!activeChat || !rootNode || !leftPaneNode ? (
        <NewChatScreen
          initialMode={newMode}
          onCreate={createChat}
          onOpenSidebar={openSidebar}
          categories={workspace.categories}
          provider={workspace.settings.provider}
          modelOptions={providerModels}
          model={workspace.settings.model}
          onModelChange={selectModel}
          reasoningEffort={workspace.settings.reasoningEffort}
          onReasoningEffortChange={selectReasoningEffort}
          sendShortcut={workspace.settings.sendShortcut}
        />
      ) : (
        <main className={`main-pane ${leftPaneIsRoot ? "" : "main-pane--stacked"}`}>
          {(chatMenuOpen || branchMenuOpen) && (
            <button
              className="chat-menu-scrim"
              type="button"
              aria-label="Close header menu"
              onClick={() => {
                setChatMenuOpen(false);
                setBranchMenuOpen(false);
                setRenamingNodeId(null);
              }}
            />
          )}
          <header className="pane-header">
            <button className="menu-button" type="button" aria-label="Open studies" onClick={openSidebar}>
              <Menu size={19} />
            </button>
            <div className="pane-header__title">
              <span>
                {leftPaneIsRoot ? "Main thread" : `Focus · depth ${leftPanePath.length - 1}`}
              </span>
              {renamingNodeId === leftPaneNode.id ? (
                <form
                  className="inline-title-editor"
                  onSubmit={(event) => {
                    event.preventDefault();
                    saveNodeName();
                  }}
                >
                  <input
                    autoFocus
                    aria-label={leftPaneIsRoot ? "Rename main thread" : "Rename branch"}
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.stopPropagation();
                        setRenamingNodeId(null);
                      }
                    }}
                  />
                  <button type="submit" disabled={!renameDraft.trim()}>Save</button>
                </form>
              ) : (
                <div className="inline-title-row">
                  <h1>
                    <InlineMath
                      source={leftPaneIsRoot ? activeChat.title : leftPaneNode.title}
                    />
                  </h1>
                  <button
                    className="inline-rename-button"
                    type="button"
                    aria-label={leftPaneIsRoot ? "Rename main thread" : "Rename branch"}
                    onClick={() => openRenameNode(leftPaneNode.id, false)}
                  >
                    <Pencil size={11} />
                  </button>
                </div>
              )}
            </div>
            <div className="pane-header__actions">
              {runtime.mode === "hosted" && (
                <button
                  className="share-chat-button"
                  type="button"
                  aria-label="Create a public read-only snapshot"
                  title="Create a public read-only snapshot"
                  disabled={shareCreating}
                  onClick={() => void shareActiveChat()}
                >
                  {shareCreating ? <LoaderCircle className="spin" size={14} /> : <Share2 size={14} />}
                  <span>{shareCreating ? "Sharing…" : "Share"}</span>
                </button>
              )}
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
                    setRenamingNodeId(null);
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
                          onRename={openRenameNode}
                          onDelete={deleteBranchSubtree}
                          onOpen={(nodeId) => {
                            historyAction.current = "push";
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
                  setRenamingNodeId(null);
                }}
              >
                <MoreHorizontal size={17} />
              </button>
              {chatMenuOpen && (
                <div className="chat-menu" aria-label="Chat options">
                  <button type="button" onClick={() => openRenameNode(rootNode.id)}>
                    <Pencil size={15} /> Rename chat
                  </button>
                  <button type="button" onClick={toggleChatPin}>
                    <Pin size={15} /> {activeChat.pinned ? "Unpin from top" : "Pin to top"}
                  </button>
                  <label className="chat-menu__move">
                    <FolderInput size={15} />
                    <span>Move to</span>
                    <select
                      aria-label="Move chat to category"
                      value={activeChat.categoryId ?? ""}
                      onChange={(event) => moveActiveChat(event.target.value)}
                    >
                      <option value="">Uncategorized</option>
                      {workspace.categories.map((category) => (
                        <option value={category.id} key={category.id}>
                          {category.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="button" onClick={exportActiveChat}>
                    <Download size={15} /> Export chat as JSON
                  </button>
                  <div className="chat-menu__divider" />
                  <button className="chat-menu__danger" type="button" onClick={deleteActiveChat}>
                    <Trash2 size={15} /> Delete chat
                  </button>
                </div>
              )}
            </div>
          </header>
          <ThreadView
            chat={activeChat}
            node={leftPaneNode}
            provider={workspace.settings.provider}
            modelOptions={providerModels}
            onSelect={setSelection}
            onOpenElaboration={(id) => {
              historyAction.current = "push";
              setActiveNodeId(id);
              setDraft(null);
              setFocusMaximized(false);
            }}
            onOpenDefinition={(definitionId, rect, getAnchorRect) =>
              setDefinitionPopover({
                chatId: activeChat.id,
                nodeId: leftPaneNode.id,
                definitionId,
                rect,
                getAnchorRect,
              })
            }
            onGenerateVisualization={(visualizationId, hint, engine) =>
              void generateVisualization(
                activeChat.id, leftPaneNode.id, visualizationId, hint, engine,
              )
            }
            onFixVisualization={(visualizationId, instruction) =>
              void reviseVisualization(activeChat.id, leftPaneNode.id, visualizationId, instruction)
            }
            onCompileVisualization={(visualizationId, source) =>
              void compileVisualization(activeChat.id, leftPaneNode.id, visualizationId, source)
            }
            onStopVisualization={(visualizationId) =>
              void stopVisualization(activeChat.id, leftPaneNode.id, visualizationId)
            }
            onDeleteVisualization={(visualizationId) =>
              deleteVisualization(activeChat.id, leftPaneNode.id, visualizationId)
            }
            onSend={(message) => sendToThread(leftPaneNode.id, message)}
            onStop={(assistantId) => stopResponse(leftPaneNode.id, assistantId)}
            onEditMessage={(revisionGroupId, content) =>
              editUserMessage(leftPaneNode.id, revisionGroupId, content)
            }
            onRegenerateResponse={(assistantId, modelOverride, reasoningOverride) =>
              regenerateAssistantMessage(
                leftPaneNode.id,
                assistantId,
                modelOverride,
                reasoningOverride,
              )
            }
            onSwitchMessageRevision={(revisionGroupId, variantId) =>
              switchMessageRevision(leftPaneNode.id, revisionGroupId, variantId)
            }
            onSwitchResponseRevision={(responseGroupId, responseId) =>
              switchResponseRevision(leftPaneNode.id, responseGroupId, responseId)
            }
            model={workspace.settings.model}
            onModelChange={selectModel}
            reasoningEffort={workspace.settings.reasoningEffort}
            onReasoningEffortChange={selectReasoningEffort}
            sendShortcut={workspace.settings.sendShortcut}
            composerInsertion={
              composerInsertion?.nodeId === leftPaneNode.id ? composerInsertion : undefined
            }
            onComposerInsertionApplied={applyComposerInsertion}
            scrollRequest={
              threadScrollRequest?.nodeId === leftPaneNode.id
                ? threadScrollRequest
                : undefined
            }
            onScrollRequestHandled={(id) =>
              setThreadScrollRequest((current) =>
                current?.id === id ? null : current,
              )
            }
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
              onClick={openSidebar}
            >
              <Menu size={19} />
            </button>
            <div className="focus-header__title">
              <span className="focus-kicker"><CornerUpRight size={13} /> New elaboration</span>
              <h2>Open a focused thread</h2>
            </div>
            <div className="focus-header__actions">
              <button className="icon-button" type="button" aria-label="Close elaboration" onClick={closeElaborationDraft}>
                <X size={17} />
              </button>
            </div>
          </header>
          <nav className="breadcrumbs" aria-label="Thread path">
            {draftPath.map((node, index) => (
              <span key={node.id}>
                {index > 0 && <ChevronRight size={12} />}
                <button type="button" onClick={() => {
                  historyAction.current = "push";
                  draftReturnView.current = null;
                  setActiveNodeId(node.id);
                  setDraft(null);
                  setFocusMaximized(false);
                }}>
                  {index === 0 ? "Main" : <InlineMath source={node.title} />}
                </button>
              </span>
            ))}
            <span><ChevronRight size={12} /><strong>New</strong></span>
          </nav>
          <div className="draft-body">
            <div className="quoted-passage">
              <span>Selected passage</span>
              <blockquote><MathBlock source={draft.quote} /></blockquote>
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
                provider={workspace.settings.provider}
                modelOptions={providerModels}
                model={workspace.settings.model}
                onModelChange={selectModel}
                reasoningEffort={workspace.settings.reasoningEffort}
                onReasoningEffortChange={selectReasoningEffort}
                sendShortcut={workspace.settings.sendShortcut}
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
              onClick={openSidebar}
            >
              <Menu size={19} />
            </button>
            <div className="focus-header__title">
              <span className="focus-kicker"><GitBranch size={13} /> Focus · depth {activePath.length - 1}</span>
              {renamingNodeId === sideNode.id ? (
                <form
                  className="inline-title-editor"
                  onSubmit={(event) => {
                    event.preventDefault();
                    saveNodeName();
                  }}
                >
                  <input
                    autoFocus
                    aria-label="Rename branch"
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.stopPropagation();
                        setRenamingNodeId(null);
                      }
                    }}
                  />
                  <button type="submit" disabled={!renameDraft.trim()}>Save</button>
                </form>
              ) : (
                <div className="inline-title-row">
                  <h2><InlineMath source={sideNode.title} /></h2>
                  <button
                    className="inline-rename-button"
                    type="button"
                    aria-label="Rename branch"
                    onClick={() => openRenameNode(sideNode.id)}
                  >
                    <Pencil size={11} />
                  </button>
                </div>
              )}
            </div>
            <div className="focus-header__actions">
              {runtime.mode === "hosted" && (
                <button
                  className="share-chat-button focus-share-button"
                  type="button"
                  aria-label="Create a public read-only snapshot"
                  title="Create a public read-only snapshot"
                  disabled={shareCreating}
                  onClick={() => void shareActiveChat()}
                >
                  {shareCreating ? <LoaderCircle className="spin" size={14} /> : <Share2 size={14} />}
                  <span>{shareCreating ? "Sharing…" : "Share"}</span>
                </button>
              )}
              <button
                className="icon-button danger"
                type="button"
                title="Delete this branch"
                aria-label="Delete this branch"
                onClick={() => deleteBranchSubtree(sideNode.id)}
              >
                <Trash2 size={16} />
              </button>
              <button
                className="icon-button focus-maximize-button"
                type="button"
                title={focusMaximized ? "Restore split view" : "Maximize focused thread"}
                aria-label={focusMaximized ? "Restore split view" : "Maximize focused thread"}
                onClick={() => {
                  historyAction.current = "push";
                  setFocusMaximized((maximized) => !maximized);
                }}
              >
                {focusMaximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </button>
              <button
                className="icon-button"
                type="button"
                aria-label="Close focused thread"
                onClick={closeFocusedThread}
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
                  <strong><InlineMath source={node.title} /></strong>
                ) : (
                  <button type="button" onClick={() => {
                    historyAction.current = "push";
                    setActiveNodeId(node.id);
                    setFocusMaximized(false);
                  }}>
                    {index === 0 ? "Main" : <InlineMath source={node.title} />}
                  </button>
                )}
              </span>
            ))}
          </nav>
          {sideNode.anchor && (
            <div className="focus-quote">
              <span>Elaborating on</span>
              <MathBlock source={sideNode.anchor.quote} />
            </div>
          )}
          <ThreadView
            chat={activeChat}
            node={sideNode}
            side
            provider={workspace.settings.provider}
            modelOptions={providerModels}
            onSelect={setSelection}
            onOpenElaboration={(id) => {
              historyAction.current = "push";
              setActiveNodeId(id);
              setFocusMaximized(false);
            }}
            onOpenDefinition={(definitionId, rect, getAnchorRect) =>
              setDefinitionPopover({
                chatId: activeChat.id,
                nodeId: sideNode.id,
                definitionId,
                rect,
                getAnchorRect,
              })
            }
            onGenerateVisualization={(visualizationId, hint, engine) =>
              void generateVisualization(
                activeChat.id, sideNode.id, visualizationId, hint, engine,
              )
            }
            onFixVisualization={(visualizationId, instruction) =>
              void reviseVisualization(activeChat.id, sideNode.id, visualizationId, instruction)
            }
            onCompileVisualization={(visualizationId, source) =>
              void compileVisualization(activeChat.id, sideNode.id, visualizationId, source)
            }
            onStopVisualization={(visualizationId) =>
              void stopVisualization(activeChat.id, sideNode.id, visualizationId)
            }
            onDeleteVisualization={(visualizationId) =>
              deleteVisualization(activeChat.id, sideNode.id, visualizationId)
            }
            onSend={(message) => sendToThread(sideNode.id, message)}
            onStop={(assistantId) => stopResponse(sideNode.id, assistantId)}
            onEditMessage={(revisionGroupId, content) =>
              editUserMessage(sideNode.id, revisionGroupId, content)
            }
            onRegenerateResponse={(assistantId, modelOverride, reasoningOverride) =>
              regenerateAssistantMessage(
                sideNode.id,
                assistantId,
                modelOverride,
                reasoningOverride,
              )
            }
            onSwitchMessageRevision={(revisionGroupId, variantId) =>
              switchMessageRevision(sideNode.id, revisionGroupId, variantId)
            }
            onSwitchResponseRevision={(responseGroupId, responseId) =>
              switchResponseRevision(sideNode.id, responseGroupId, responseId)
            }
            model={workspace.settings.model}
            onModelChange={selectModel}
            reasoningEffort={workspace.settings.reasoningEffort}
            onReasoningEffortChange={selectReasoningEffort}
            sendShortcut={workspace.settings.sendShortcut}
            composerInsertion={
              composerInsertion?.nodeId === sideNode.id ? composerInsertion : undefined
            }
            onComposerInsertionApplied={applyComposerInsertion}
            scrollRequest={
              threadScrollRequest?.nodeId === sideNode.id
                ? threadScrollRequest
                : undefined
            }
            onScrollRequestHandled={(id) =>
              setThreadScrollRequest((current) =>
                current?.id === id ? null : current,
              )
            }
          />
        </aside>
      )}

      {settingsOpen && (
        <div
          className="settings-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSettingsOpen(false);
          }}
        >
          <section
            className="settings-modal settings-modal--workspace"
            role="dialog"
            aria-modal="true"
            aria-labelledby="workspace-settings-title"
          >
            <header>
              <div>
                <span>Workspace</span>
                <h2 id="workspace-settings-title">Settings</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Close settings"
                onClick={() => setSettingsOpen(false)}
              >
                <X size={17} />
              </button>
            </header>

            <div className="settings-view">
              {runtime.mode === "hosted" && runtime.user && (
                <section className="settings-view__section">
                  <header>
                    <h3>Account</h3>
                    <p>Your chats, settings, usage, and provider keys are private to this account.</p>
                  </header>
                  <div className="settings-view__actions">
                    <div className="custom-instructions-button account-summary">
                      <UserRound size={15} />
                      <span>
                        <small>{runtime.user.email}</small>
                        <strong>{runtime.user.name}</strong>
                      </span>
                    </div>
                    <button
                      className="custom-instructions-button"
                      type="button"
                      onClick={() => {
                        setSettingsOpen(false);
                        void onSignOut();
                      }}
                    >
                      <LogOut size={15} />
                      <span>
                        <small>Account session</small>
                        <strong>Sign out</strong>
                      </span>
                      <ChevronRight size={13} />
                    </button>
                    {isAdministrator && (
                      <button
                        className="custom-instructions-button"
                        type="button"
                        onClick={() => {
                          setSettingsOpen(false);
                          setAdminAccountsOpen(true);
                        }}
                      >
                        <ShieldCheck size={15} />
                        <span>
                          <small>Administration</small>
                          <strong>Manage accounts</strong>
                        </span>
                        <ChevronRight size={13} />
                      </button>
                    )}
                    <button
                      className="custom-instructions-button"
                      type="button"
                      onClick={() => {
                        setSettingsOpen(false);
                        setSharedChatsOpen(true);
                      }}
                    >
                      <Link2 size={15} />
                      <span>
                        <small>Public snapshots</small>
                        <strong>Manage shared chats</strong>
                      </span>
                      <ChevronRight size={13} />
                    </button>
                  </div>
                </section>
              )}
              <section className="settings-view__section">
                <header>
                  <h3>Generation</h3>
                  <p>Model and reasoning effort are selected together in each chat box.</p>
                </header>
                <div className="settings-view__grid">
                  <label className="settings-select-control">
                    <ServerCog size={15} />
                    <span>
                      <small>Provider</small>
                      <select
                        aria-label="Model provider"
                        value={workspace.settings.provider}
                        onChange={(event) =>
                          selectProvider(event.target.value as ProviderId)
                        }
                      >
                        {availableProviders.map((provider) => (
                          <option value={provider.id} key={provider.id}>
                            {provider.label} · {provider.note}
                          </option>
                        ))}
                      </select>
                    </span>
                  </label>
                  <label className="model-select">
                    <Hash size={15} />
                    <span>
                      <small>Output-token limit · 0 = model maximum</small>
                      <input
                        type="number"
                        min={0}
                        step={1_000}
                        inputMode="numeric"
                        aria-label="Maximum output tokens"
                        title="Includes reasoning and visible output tokens; 0 removes Locus's limit"
                        value={workspace.settings.maxOutputTokens}
                        onChange={(event) => {
                          const maxOutputTokens = event.currentTarget.valueAsNumber;
                          if (
                            !Number.isSafeInteger(maxOutputTokens) ||
                            maxOutputTokens < 0
                          ) {
                            return;
                          }
                          setWorkspace((current) => ({
                            ...current,
                            settings: { ...current.settings, maxOutputTokens },
                          }));
                        }}
                      />
                    </span>
                  </label>
                  <label className="model-select">
                    <BookOpen size={15} />
                    <span>
                      <small>Define model · {providerLabel(workspace.settings.provider)}</small>
                      {workspace.settings.provider === "openai" ? (
                        <select
                          aria-label="Model used for definitions"
                          value={
                            workspace.settings.definitionModels[
                              workspace.settings.provider
                            ]
                          }
                          onChange={(event) =>
                            selectDefinitionModel(event.target.value)
                          }
                        >
                          {MODEL_OPTIONS.map((model) => (
                            <option value={model.value} key={model.value}>
                              {model.label} · {model.note}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <>
                          <input
                            aria-label="Model used for definitions"
                            value={
                              workspace.settings.definitionModels[
                                workspace.settings.provider
                              ]
                            }
                            onChange={(event) =>
                              selectDefinitionModel(event.target.value)
                            }
                            list="definition-model-options"
                            placeholder={
                              workspace.settings.provider === "openrouter"
                                ? "provider/model"
                                : "Model ID"
                            }
                            spellCheck={false}
                          />
                          <datalist id="definition-model-options">
                            {providerModels.map((model) => (
                              <option value={model.id} key={model.id}>
                                {model.name ?? model.id}
                              </option>
                            ))}
                          </datalist>
                        </>
                      )}
                    </span>
                  </label>
                  <label className="model-select">
                    <ChartNoAxesCombined size={15} />
                    <span>
                      <small>Visualization model · {providerLabel(workspace.settings.provider)}</small>
                      {workspace.settings.provider === "openai" ? (
                        <select
                          aria-label="Model used for visualizations"
                          value={
                            workspace.settings.visualizationModels[
                              workspace.settings.provider
                            ]
                          }
                          onChange={(event) => selectVisualizationModel(event.target.value)}
                        >
                          {MODEL_OPTIONS.map((model) => (
                            <option value={model.value} key={model.value}>
                              {model.label} · {model.note}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <>
                          <input
                            aria-label="Model used for visualizations"
                            value={
                              workspace.settings.visualizationModels[
                                workspace.settings.provider
                              ]
                            }
                            onChange={(event) => selectVisualizationModel(event.target.value)}
                            list="visualization-model-options"
                            placeholder={
                              workspace.settings.provider === "openrouter"
                                ? "provider/model"
                                : "Model ID"
                            }
                            spellCheck={false}
                          />
                          <datalist id="visualization-model-options">
                            {providerModels.map((model) => (
                              <option value={model.id} key={model.id}>
                                {model.name ?? model.id}
                              </option>
                            ))}
                          </datalist>
                        </>
                      )}
                      <select
                        className="visualization-reasoning-select"
                        aria-label="Reasoning effort used for visualizations"
                        value={
                          workspace.settings.visualizationReasoningEfforts[
                            workspace.settings.provider
                          ]
                        }
                        onChange={(event) =>
                          selectVisualizationReasoningEffort(
                            event.target.value as ReasoningEffort,
                          )
                        }
                      >
                        {REASONING_OPTIONS.map((effort) => (
                          <option
                            value={effort.value}
                            key={effort.value}
                            disabled={
                              effort.value === "max" &&
                              workspace.settings.provider === "openai" &&
                              !workspace.settings.visualizationModels.openai.startsWith("gpt-5.6")
                            }
                          >
                            {effort.label} reasoning
                          </option>
                        ))}
                      </select>
                    </span>
                  </label>
                  {workspace.settings.provider === "local" && (
                    <label className="model-select provider-url-control">
                      <ServerCog size={15} />
                      <span>
                        <small>OpenAI-compatible base URL</small>
                        <input
                          type="url"
                          value={workspace.settings.localBaseUrl}
                          onChange={(event) =>
                            setWorkspace((current) => ({
                              ...current,
                              settings: {
                                ...current.settings,
                                localBaseUrl: event.target.value,
                              },
                            }))
                          }
                          placeholder={DEFAULT_LOCAL_BASE_URL}
                          aria-label="Local OpenAI-compatible base URL"
                          spellCheck={false}
                        />
                      </span>
                    </label>
                  )}
                </div>
                {workspace.settings.provider !== "openai" && (
                  <p className={`provider-catalog-status provider-catalog-status--${providerModelsStatus}`}>
                    {providerModelsStatus === "loading"
                      ? "Loading model IDs…"
                      : providerModelsStatus === "loaded"
                        ? `${providerModels.length.toLocaleString()} model IDs available in the chat, Define, and Visualization model fields.`
                        : providerModelsStatus === "error"
                          ? "The model catalog is unavailable; you can still enter a model ID manually."
                          : "Enter a model ID in the chat box."}
                  </p>
                )}
              </section>

              <section className="settings-view__section">
                <header>
                  <h3>Behavior and connection</h3>
                </header>
                <div className="settings-view__actions">
                  <button
                    className="custom-instructions-button api-key-button"
                    type="button"
                    onClick={() => {
                      setSettingsOpen(false);
                      setCredentialProvider(workspace.settings.provider);
                      setApiKeyDraft("");
                      setApiKeyError("");
                      setApiKeyOpen(true);
                    }}
                  >
                    <KeyRound size={15} />
                    <span>
                      <small>
                        {providerLabel(workspace.settings.provider)} API key
                        {workspace.settings.provider === "local" ? " · optional" : ""}
                      </small>
                      <strong>
                        {!providerStatuses
                          ? "Checking…"
                          : providerStatuses[workspace.settings.provider].source === "saved"
                            ? "Saved in Locus"
                            : providerStatuses[workspace.settings.provider].source === "project-file"
                              ? "Project file"
                              : workspace.settings.provider === "local"
                                ? "No key"
                                : "Not configured"}
                      </strong>
                    </span>
                    <ChevronRight size={13} />
                  </button>
                  <button
                    className="custom-instructions-button"
                    type="button"
                    onClick={() => {
                      setSettingsOpen(false);
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
                  <label className="settings-select-control">
                    <CornerDownLeft size={15} />
                    <span>
                      <small>Send messages with</small>
                      <select
                        aria-label="Keyboard shortcut for sending messages"
                        value={workspace.settings.sendShortcut}
                        onChange={(event) =>
                          setWorkspace((current) => ({
                            ...current,
                            settings: {
                              ...current.settings,
                              sendShortcut:
                                event.target.value === "mod-enter"
                                  ? "mod-enter"
                                  : "enter",
                            },
                          }))
                        }
                      >
                        <option value="enter">Enter</option>
                        <option value="mod-enter">⌘/Ctrl + Enter</option>
                      </select>
                    </span>
                  </label>
                </div>
              </section>

              <section className="settings-view__section">
                <header>
                  <h3>Appearance</h3>
                </header>
                <button
                  className="theme-toggle-button"
                  type="button"
                  aria-label={
                    workspace.settings.theme === "dark"
                      ? "Use light mode"
                      : "Use dark mode"
                  }
                  aria-pressed={workspace.settings.theme === "dark"}
                  onClick={toggleTheme}
                >
                  {workspace.settings.theme === "dark" ? (
                    <Sun size={15} />
                  ) : (
                    <Moon size={15} />
                  )}
                  <span>
                    <small>Color theme</small>
                    <strong>
                      {workspace.settings.theme === "dark" ? "Dark mode" : "Light mode"}
                    </strong>
                  </span>
                  <i className="theme-switch" aria-hidden="true"><span /></i>
                </button>
                <label className="text-size-control">
                  <SlidersHorizontal size={15} />
                  <span>
                    <small>Chat text size</small>
                    <strong>{workspace.settings.textScale}%</strong>
                  </span>
                  <input
                    type="range"
                    min={80}
                    max={140}
                    step={5}
                    value={workspace.settings.textScale}
                    aria-label="Chat text size"
                    onChange={(event) => {
                      const textScale = Number(event.target.value);
                      setWorkspace((current) => ({
                        ...current,
                        settings: { ...current.settings, textScale },
                      }));
                    }}
                  />
                </label>
              </section>

              <section className="settings-view__section">
                <header>
                  <h3>Data</h3>
                  <p>Transfer chats without changing the local originals.</p>
                </header>
                <div className="settings-view__data-actions">
                  <button
                    type="button"
                    disabled={!workspace.chats.length && !workspace.categories.length}
                    onClick={exportAllChats}
                  >
                    <Download size={15} />
                    <span>
                      <strong>Export all</strong>
                      <small>Download the full library as JSON</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSettingsOpen(false);
                      setJsonImportOpen(true);
                    }}
                  >
                    <Upload size={15} />
                    <span>
                      <strong>Import JSON</strong>
                      <small>Add a Locus export to this workspace</small>
                    </span>
                  </button>
                </div>
              </section>
            </div>

            <footer className="settings-view__footer">
              <div className={`save-status save-status--${saveState}`}>
                <i />
                {saveState === "saved"
                  ? runtime.mode === "hosted" ? "Saved securely" : "Saved locally"
                  : saveState === "saving"
                    ? "Saving…"
                    : "Save failed"}
              </div>
              <button
                className="primary-button"
                type="button"
                onClick={() => setSettingsOpen(false)}
              >
                Done
              </button>
            </footer>
          </section>
        </div>
      )}

      {adminAccountsOpen && isAdministrator && runtime.user && (
        <AdminAccountsModal
          currentUserId={runtime.user.id}
          onClose={() => setAdminAccountsOpen(false)}
        />
      )}

      {sharedChatsOpen && runtime.mode === "hosted" && (
        <SharedChatsModal onClose={() => setSharedChatsOpen(false)} />
      )}

      {shareResult && runtime.mode === "hosted" && (
        <ShareCreatedModal share={shareResult} onClose={() => setShareResult(null)} />
      )}

      {shareError && (
        <div className="share-error-toast" role="alert">
          <span>{shareError}</span>
          <button type="button" aria-label="Dismiss share error" onClick={() => setShareError("")}>
            <X size={13} />
          </button>
        </div>
      )}

      {categoryEditor && (
        <div
          className="settings-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setCategoryEditor(null);
          }}
        >
          <section
            className="settings-modal settings-modal--compact"
            role="dialog"
            aria-modal="true"
            aria-labelledby="category-editor-title"
          >
            <header>
              <div>
                <span>Library</span>
                <h2 id="category-editor-title">
                  {categoryEditor.categoryId ? "Rename category" : "Create category"}
                </h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Close category editor"
                onClick={() => setCategoryEditor(null)}
              >
                <X size={17} />
              </button>
            </header>
            <label className="settings-field">
              <span>Category name</span>
              <input
                autoFocus
                value={categoryEditor.name}
                onChange={(event) =>
                  setCategoryEditor((current) =>
                    current ? { ...current, name: event.target.value } : current,
                  )
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") saveCategory();
                }}
                placeholder="e.g. Linear algebra"
              />
            </label>
            {workspace.categories.some(
              (category) =>
                category.id !== categoryEditor.categoryId &&
                category.name.trim().toLowerCase() ===
                  categoryEditor.name.trim().toLowerCase(),
            ) && <p className="settings-field-error">A category with this name already exists.</p>}
            <footer>
              <button
                className="secondary-button"
                type="button"
                onClick={() => setCategoryEditor(null)}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={
                  !categoryEditor.name.trim() ||
                  workspace.categories.some(
                    (category) =>
                      category.id !== categoryEditor.categoryId &&
                      category.name.trim().toLowerCase() ===
                        categoryEditor.name.trim().toLowerCase(),
                  )
                }
                onClick={saveCategory}
              >
                {categoryEditor.categoryId ? "Save name" : "Create category"}
              </button>
            </footer>
          </section>
        </div>
      )}

      {jsonImportOpen && (
        <div
          className="settings-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) resetJsonImport();
          }}
        >
          <section
            className="settings-modal settings-modal--json-import"
            role="dialog"
            aria-modal="true"
            aria-labelledby="json-import-title"
          >
            <header>
              <div>
                <span>Data transfer</span>
                <h2 id="json-import-title">Import chats from JSON</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Close JSON import"
                onClick={resetJsonImport}
              >
                <X size={17} />
              </button>
            </header>
            <p>
              Choose a Locus export. Imported chats receive new IDs, so importing a file
              never overwrites the chats already here.
            </p>
            <label className="json-file-picker">
              <Upload size={18} />
              <span>
                <strong>{jsonImportFilename || "Choose a JSON file"}</strong>
                <small>Locus exports and workspace data files are supported.</small>
              </span>
              <input
                type="file"
                accept="application/json,.json"
                onChange={(event) => void readJsonImportFile(event.target.files?.[0])}
              />
            </label>
            {jsonImportError && (
              <p className="json-import-error" role="alert">{jsonImportError}</p>
            )}
            {jsonImport && (
              <>
                <div className="json-import-summary">
                  <span>{jsonImport.scopeLabel}</span>
                  <strong>
                    {jsonImport.chats.length} {jsonImport.chats.length === 1 ? "chat" : "chats"}
                    {" · "}
                    {jsonImport.categories.length}{" "}
                    {jsonImport.categories.length === 1 ? "category" : "categories"}
                  </strong>
                </div>
                {jsonImport.chats.length > 0 ? (
                  <label className="settings-field">
                    <span>Import chats into</span>
                    <select
                      value={jsonImportTarget}
                      onChange={(event) => setJsonImportTarget(event.target.value)}
                    >
                      {jsonImport.categories.length > 0 && (
                        <option value="preserve">Keep exported categories</option>
                      )}
                      <option value="uncategorized">Uncategorized</option>
                      {workspace.categories.map((category) => (
                        <option value={category.id} key={category.id}>
                          {category.name}
                        </option>
                      ))}
                      <option value="new">New category…</option>
                    </select>
                  </label>
                ) : (
                  <p className="json-category-only-note">
                    The exported categories will be recreated and merged with matching names.
                  </p>
                )}
                {jsonImportTarget === "new" && jsonImport.chats.length > 0 && (
                  <label className="settings-field">
                    <span>New category name</span>
                    <input
                      autoFocus
                      value={jsonImportNewCategory}
                      onChange={(event) => setJsonImportNewCategory(event.target.value)}
                      placeholder="Category name"
                    />
                  </label>
                )}
              </>
            )}
            <footer>
              <button className="secondary-button" type="button" onClick={resetJsonImport}>
                Cancel
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={
                  !jsonImport ||
                  (jsonImportTarget === "new" && !jsonImportNewCategory.trim())
                }
                onClick={importJsonChats}
              >
                Import
              </button>
            </footer>
          </section>
        </div>
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
              onKeyDown={(event) => {
                applyMarkdownShortcut(
                  event,
                  customInstructionsDraft,
                  setCustomInstructionsDraft,
                );
              }}
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

      {apiKeyOpen && (
        <div
          className="settings-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeApiKeyModal();
          }}
        >
          <section
            className="settings-modal settings-modal--api-key"
            role="dialog"
            aria-modal="true"
            aria-labelledby="api-key-title"
          >
            <header>
              <div>
                <span>Connection</span>
                <h2 id="api-key-title">{providerLabel(credentialProvider)} API key</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Close API key settings"
                onClick={closeApiKeyModal}
              >
                <X size={17} />
              </button>
            </header>
            <p>
              Paste a key here to store it in a private local file. Locus never returns the
              saved value to the browser or includes it in your chat data.
              {credentialProvider === "local"
                ? " Local endpoints that do not require authentication can leave this unset."
                : " A pasted key takes precedence over the matching project key file."}
            </p>
            <input
              autoFocus
              type="password"
              value={apiKeyDraft}
              onChange={(event) => setApiKeyDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && apiKeyDraft.trim() && !apiKeySaving) {
                  void savePastedApiKey();
                }
              }}
              placeholder={
                credentialProvider === "openai"
                  ? "sk-… or OPENAI_API_KEY=sk-…"
                  : credentialProvider === "openrouter"
                    ? "sk-or-… or OPENROUTER_API_KEY=sk-or-…"
                    : "Optional bearer token"
              }
              aria-label={`${providerLabel(credentialProvider)} API key`}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="api-key-storage-note">
              Stored at <code>
                {credentialProvider === "openai"
                  ? "data/openai-api-key.txt"
                  : credentialProvider === "openrouter"
                    ? "data/openrouter-api-key.txt"
                    : "data/local-api-key.txt"}
              </code> with owner-only permissions.
            </p>
            {apiKeyError && <p className="api-key-error" role="alert">{apiKeyError}</p>}
            <footer>
              {providerStatuses?.[credentialProvider].source === "saved" && (
                <button
                  className="secondary-button api-key-clear-button"
                  type="button"
                  disabled={apiKeySaving}
                  onClick={() => void clearSavedApiKey()}
                >
                  Clear saved key
                </button>
              )}
              <button className="secondary-button" type="button" onClick={closeApiKeyModal}>
                Cancel
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={!apiKeyDraft.trim() || apiKeySaving}
                onClick={() => void savePastedApiKey()}
              >
                {apiKeySaving ? "Saving…" : "Save API key"}
              </button>
            </footer>
          </section>
        </div>
      )}

      {selection && !draft && (
        <SelectionToolbar
          selection={selection}
          onDismiss={() => setSelection(null)}
          onDefine={defineSelection}
          onVisualize={visualizeSelection}
          onQuote={quoteSelectionInThread}
          onElaborate={() => {
            if (activeChat && activeNode) {
              draftReturnView.current = {
                chatId: activeChat.id,
                nodeId: activeNode.id,
                maximized: focusMaximized,
              };
            }
            setThreadScrollRequest({
              id: newId(),
              nodeId: selection.sourceNodeId,
              anchor: {
                sourceNodeId: selection.sourceNodeId,
                sourceMessageId: selection.sourceMessageId,
                quote: selection.quote,
                blockIndex: selection.blockIndex,
              },
            });
            setDraft(selection);
            setSelection(null);
            setFocusMaximized(false);
          }}
        />
      )}

      {definitionPopover && displayedDefinition && (
        <DefinitionPopover
          definition={displayedDefinition}
          rect={definitionPopover.rect}
          getAnchorRect={definitionPopover.getAnchorRect}
          onStop={() =>
            void stopDefinition(
              definitionPopover.chatId,
              definitionPopover.nodeId,
              definitionPopover.definitionId,
            )
          }
          onDismiss={() => setDefinitionPopover(null)}
        />
      )}
    </div>
  );
}
