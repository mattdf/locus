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

export interface ThreadNode {
  id: string;
  parentId: string | null;
  title: string;
  anchor?: HighlightAnchor;
  messages: Message[];
  definitions?: InlineDefinition[];
  messageRevisions?: Record<string, MessageRevisionGroup>;
  responseRevisions?: Record<string, ResponseRevisionGroup>;
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
}

export interface ContextNode {
  title: string;
  messages: Array<Pick<Message, "role" | "content">>;
}
