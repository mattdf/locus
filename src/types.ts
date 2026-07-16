export type MessageRole = "user" | "assistant" | "source";
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  pending?: boolean;
  error?: boolean;
  stopped?: boolean;
  requestId?: string;
  revisionGroupId?: string;
  revisionVariantId?: string;
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

export interface HighlightAnchor {
  sourceNodeId: string;
  sourceMessageId: string;
  quote: string;
  blockIndex: number;
}

export interface ThreadNode {
  id: string;
  parentId: string | null;
  title: string;
  anchor?: HighlightAnchor;
  messages: Message[];
  messageRevisions?: Record<string, MessageRevisionGroup>;
  createdAt: string;
  updatedAt: string;
}

export interface ChatTree {
  id: string;
  title: string;
  pinned?: boolean;
  rootId: string;
  nodes: Record<string, ThreadNode>;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceState {
  version: 1;
  chats: ChatTree[];
  activeChatId: string | null;
  settings: {
    model: string;
    reasoningEffort: ReasoningEffort;
    customInstructions: string;
    focusDrawerWidth: number;
    sidebarCollapsed: boolean;
    theme: "light" | "dark";
  };
}

export interface SelectionDraft extends HighlightAnchor {
  rect: { left: number; top: number; width: number; height: number };
}

export interface ContextNode {
  title: string;
  messages: Array<Pick<Message, "role" | "content">>;
}
