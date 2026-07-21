export type MessageRole = "user" | "assistant" | "source";
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";
export type SendShortcut = "enter" | "mod-enter";
export type ProviderId = "openai" | "openrouter" | "local";

export interface ProviderModelOption {
  id: string;
  name?: string;
}

export interface GenerationMetrics {
  durationMs: number;
  provider?: ProviderId | null;
  model?: string | null;
  inputTokens: number | null;
  cachedInputTokens?: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  inputCostUsd?: number | null;
  outputCostUsd?: number | null;
  totalCostUsd?: number | null;
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  pending?: boolean;
  error?: boolean;
  stopped?: boolean;
  requestId?: string;
  generation?: GenerationMetrics;
  revisionGroupId?: string;
  revisionVariantId?: string;
  responseRevisionGroupId?: string;
}

export interface MessageRevisionVariant {
  id: string;
  userMessage: Message;
  assistantMessage: Message;
}

export interface MessageRevisionGroup {
  userMessageId: string;
  assistantMessageId: string;
  activeVariantId: string;
  variants: MessageRevisionVariant[];
}

export interface ResponseRevisionGroup {
  assistantMessageId: string;
  activeResponseId: string;
  responses: Message[];
}

export interface HighlightAnchor {
  sourceNodeId: string;
  sourceMessageId: string;
  quote: string;
  blockIndex: number;
  /** Raw Markdown offsets. Older anchors are resolved from quote/blockIndex on demand. */
  start?: number;
  end?: number;
  prefix?: string;
  suffix?: string;
  status?: "resolved" | "needs-review";
}

export interface SourceAnchorSnapshot {
  id: string;
  anchor: HighlightAnchor;
}

export interface SourceEditUndo {
  id: string;
  sourceMessageId: string;
  previousContent: string;
  branches: SourceAnchorSnapshot[];
  definitions: SourceAnchorSnapshot[];
  visualizations: SourceAnchorSnapshot[];
  createdAt: string;
}

export interface InlineDefinition {
  id: string;
  anchor: HighlightAnchor;
  content: string;
  createdAt: string;
  pending?: boolean;
  error?: boolean;
  requestId?: string;
  generation?: GenerationMetrics;
}

export type VisualizationStatus =
  | "draft"
  | "generating"
  | "compiling"
  | "ready"
  | "error";

export type VisualizationEngine = "metapost" | "tikz";

export interface InlineVisualization {
  id: string;
  anchor: HighlightAnchor;
  hint: string;
  status: VisualizationStatus;
  /** Undefined on visualizations created before the engine selector was added. */
  engine?: VisualizationEngine;
  /** Engine-agnostic source used by current visualizations. */
  source?: string;
  /** Legacy MetaPost source retained for backwards-compatible imports. */
  metapostSource?: string;
  svg?: string;
  errorStage?: "model" | "compile";
  errorMessage?: string;
  compilerLog?: string;
  requestId?: string;
  generation?: GenerationMetrics;
  compileDurationMs?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadNode {
  id: string;
  parentId: string | null;
  title: string;
  anchor?: HighlightAnchor;
  messages: Message[];
  definitions?: InlineDefinition[];
  visualizations?: InlineVisualization[];
  messageRevisions?: Record<string, MessageRevisionGroup>;
  responseRevisions?: Record<string, ResponseRevisionGroup>;
  /** The latest reversible source edit. Cleared by the next source/annotation edit. */
  sourceEditUndo?: SourceEditUndo;
  createdAt: string;
  updatedAt: string;
}

export interface ChatTree {
  id: string;
  title: string;
  pinned?: boolean;
  categoryId?: string | null;
  rootId: string;
  nodes: Record<string, ThreadNode>;
  createdAt: string;
  updatedAt: string;
}

export interface ChatCategory {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceState {
  version: 1;
  categories: ChatCategory[];
  chats: ChatTree[];
  activeChatId: string | null;
  settings: {
    provider: ProviderId;
    providerModels: Record<ProviderId, string>;
    definitionModels: Record<ProviderId, string>;
    visualizationModels: Record<ProviderId, string>;
    visualizationReasoningEfforts: Record<ProviderId, ReasoningEffort>;
    localBaseUrl: string;
    model: string;
    reasoningEffort: ReasoningEffort;
    maxOutputTokens: number;
    customInstructions: string;
    focusDrawerWidth: number;
    sidebarCollapsed: boolean;
    collapsedCategoryIds: string[];
    theme: "light" | "dark";
    textScale: number;
    sendShortcut: SendShortcut;
  };
}

export interface SelectionDraft extends HighlightAnchor {
  rect: { left: number; top: number; width: number; height: number };
  endBlockIndex?: number;
  sectionStart?: number;
  sectionEnd?: number;
  sectionContent?: string;
}

export interface ContextNode {
  title: string;
  messages: Array<Pick<Message, "role" | "content">>;
}
