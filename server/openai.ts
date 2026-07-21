import { readFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type {
  ContextNode,
  HighlightAnchor,
  ProviderKind,
  ReasoningEffort,
} from "../src/types.ts";
import {
  createProviderClient,
  getProviderStatus,
  saveProviderApiKey,
  type ProviderCredentialStatus,
} from "./providers.ts";

const SYSTEM_PROMPT_FILE = path.resolve("SYSTEM_PROMPT.md");
const VISUALIZATION_PROMPT_FILE = path.resolve("VISUALIZATION_PROMPT.md");
const SOURCE_REWRITE_PROMPT_FILE = path.resolve("SOURCE_REWRITE_PROMPT.md");

export async function getApiKeyStatus(): Promise<ProviderCredentialStatus> {
  return getProviderStatus("openai");
}

export async function saveApiKey(raw: string): Promise<ProviderCredentialStatus> {
  return saveProviderApiKey("openai", raw);
}

async function readPromptFile(file: string, displayName: string): Promise<string> {
  const prompt = (await readFile(file, "utf8")).trim();
  if (!prompt) throw new Error(`${displayName} is empty`);
  return prompt;
}

function visualizationContract(engine: "metapost" | "tikz"): string {
  if (engine === "tikz") {
    return String.raw`<engine_contract engine="tikz">
Return only the contents of one tikzpicture. Do not include Markdown, prose, a document preamble, or begin/end tikzpicture.

The compiler preloads TikZ with arrows.meta, positioning, calc, fit, matrix, intersections, decorations.pathreplacing, backgrounds, and patterns. It provides colors locusBg, locusPanel, locusInk, locusMuted, locusGuide, locusBlue, locusTeal, locusPurple, and locusOrange, plus styles "locus guide", "locus line", "locus strong", "locus arrow", "locus panel", "locus label", and "locus muted". Use these directly. Use the palette semantically; do not force every color into the figure.

Use ordinary LaTeX math in nodes. Standard LaTeX constructs provided by the preloaded packages may be used when they materially improve the figure.

Choose bounds and aspect ratio for the concept. Begin with an explicit \path[use as bounding box] (...) rectangle (...); and fill that rectangle with locusBg. Use named coordinates, anchors, relative positioning, and explicit spacing. Keep every node, label, path, arrowhead, and brace inside the bounds with generous margins.
</engine_contract>`;
  }

  return String.raw`<engine_contract engine="metapost">
Return only the body of one MetaPost figure, to be inserted inside beginfig(1) ... endfig. Do not include Markdown or explanatory prose outside the figure. Define every variable except the palette and line weights listed below.

The compiler provides colors locusBg, locusPanel, locusInk, locusMuted, locusGuide, locusBlue, locusTeal, locusPurple, and locusOrange, plus numeric weights locusThin, locusMedium, and locusStrong. Use the palette semantically; do not force every color into the figure. Give every visible label an explicit withcolor.

Put all visible text in btex ... etex and use ordinary LaTeX math there; never use quoted MetaPost strings for visible text. Standard LaTeX constructs provided by the preloaded packages may be used. Prefer \mathrm{...}, \mathbf{...}, and other modern scoped forms when practical, and prefer simpler equivalent notation over exotic commands.

MetaPost treats trailing digits as suffixes. Never declare names such as p0, q1, or x2 individually. Either use descriptive word names such as pZero, or declare each suffix family once (for example, pair p[];) before using p0, p1, and so on.

Declare numeric canvasWidth and canvasHeight and choose their aspect ratio for the concept. Fill unitsquare xscaled canvasWidth yscaled canvasHeight with locusBg at the start, keep all content inside with generous margins, and finish with exactly: setbounds currentpicture to unitsquare xscaled canvasWidth yscaled canvasHeight;
</engine_contract>`;
}

function formatContext(context: ContextNode[]): string {
  return context
    .map((node, index) => {
      const turns = node.messages
        .filter((message) => message.content.trim())
        .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
        .join("\n\n");
      return `<thread depth="${index}" title="${node.title}">\n${turns}\n</thread>`;
    })
    .join("\n\n");
}

export interface RespondInput {
  provider: ProviderKind;
  providerLabel?: string;
  baseUrl?: string;
  model: string;
  context: ContextNode[];
  message: string;
  reasoningEffort: ReasoningEffort;
  maxOutputTokens: number;
  customInstructions: string;
  anchor?: HighlightAnchor;
  purpose?: "chat" | "definition" | "visualization" | "rewrite";
  visualizationEngine?: "metapost" | "tikz";
  apiKey?: string;
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd?: number;
}

function buildPrompt(input: RespondInput, basePrompt: string) {
  const highlighted = input.anchor
    ? `\n\nThe learner selected this exact passage:\n<highlighted_passage>\n${input.anchor.quote}\n</highlighted_passage>`
    : "";
  const customInstructions =
    input.purpose !== "visualization" &&
    input.purpose !== "rewrite" &&
    input.customInstructions.trim()
    ? `\n\nThe learner also supplied these additional behavior preferences. Follow them where compatible with the tutoring instructions above; they supplement rather than replace the tutoring role:\n<custom_instructions>\n${input.customInstructions.trim()}\n</custom_instructions>`
    : "";
  const instructions = input.purpose === "visualization"
    ? `${basePrompt}\n\n${visualizationContract(input.visualizationEngine ?? "metapost")}`
    : basePrompt + customInstructions;
  const hasSuppliedContext = input.context.some((node) =>
    node.messages.some((message) => message.content.trim()),
  );
  const request = input.purpose === "visualization"
    ? `${
        hasSuppliedContext
          ? `The learner explicitly supplied this additional context for interpreting the selection:\n\n${formatContext(input.context)}`
          : "The learner chose to send only the highlighted passage. Do not assume access to the rest of its containing message."
      }${highlighted}\n\n<learner_request>\n${input.message}\n</learner_request>`
    : `Here is the complete path of conversation context:\n\n${formatContext(input.context)}${highlighted}\n\n<learner_request>\n${input.message}\n</learner_request>`;
  return {
    instructions,
    request,
  };
}

function ensureVisibleText(
  receivedText: boolean,
  incompleteReason: "max_output_tokens" | "length" | "content_filter" | null,
): void {
  if (receivedText) return;
  if (incompleteReason === "max_output_tokens" || incompleteReason === "length") {
    throw new Error("The model exhausted the output-token limit before producing visible text");
  }
  if (incompleteReason === "content_filter") {
    throw new Error("The model returned no text because the response was filtered");
  }
  throw new Error("The model returned no text");
}

async function streamOpenAIResponse(
  input: RespondInput,
  instructions: string,
  request: string,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
): Promise<TokenUsage | null> {
  const openai = await createProviderClient("openai", undefined, input.apiKey);
  const stream = await openai.responses.create(
    {
      model: input.model,
      instructions,
      input: request,
      reasoning: { effort: input.reasoningEffort },
      ...(input.maxOutputTokens === 0
        ? {}
        : { max_output_tokens: input.maxOutputTokens }),
      stream: true,
    },
    { signal },
  );

  let receivedText = false;
  let usage: TokenUsage | null = null;
  let terminalError: string | null = null;
  let incompleteReason: "max_output_tokens" | "content_filter" | null = null;
  for await (const event of stream) {
    if (event.type === "response.output_text.delta") {
      receivedText = true;
      onDelta(event.delta);
    } else if (
      event.type === "response.completed" ||
      event.type === "response.incomplete" ||
      event.type === "response.failed"
    ) {
      const responseUsage = event.response.usage;
      if (responseUsage) {
        usage = {
          inputTokens: responseUsage.input_tokens,
          cachedInputTokens: responseUsage.input_tokens_details?.cached_tokens ?? 0,
          outputTokens: responseUsage.output_tokens,
          reasoningTokens: responseUsage.output_tokens_details?.reasoning_tokens ?? 0,
          totalTokens: responseUsage.total_tokens,
        };
      }
      if (event.type === "response.failed") {
        terminalError = event.response.error?.message ?? "The model request failed";
      } else if (event.type === "response.incomplete") {
        incompleteReason = event.response.incomplete_details?.reason ?? null;
      }
    } else if (event.type === "error") {
      terminalError = event.message;
    }
  }
  if (terminalError) throw new Error(terminalError);
  ensureVisibleText(receivedText, incompleteReason);
  return usage;
}

async function streamCompatibleChat(
  input: RespondInput,
  instructions: string,
  request: string,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
): Promise<TokenUsage | null> {
  const client = await createProviderClient(input.provider, input.baseUrl, input.apiKey);
  const messages = [
    { role: "system" as const, content: instructions },
    { role: "user" as const, content: request },
  ];
  const supportsReasoningEffort = input.provider === "openrouter" || input.provider === "custom";
  const createStream = (minimalRequest = false) =>
    client.chat.completions.create(
      {
        model: input.model,
        messages,
        ...(minimalRequest || !supportsReasoningEffort ? {} : { reasoning_effort: input.reasoningEffort }),
        ...(!minimalRequest && input.provider === "glm"
          ? { thinking: { type: input.reasoningEffort === "none" ? "disabled" : "enabled" } }
          : {}),
        ...(input.maxOutputTokens === 0
          ? {}
          : input.provider === "openrouter"
            ? { max_completion_tokens: input.maxOutputTokens }
            : { max_tokens: input.maxOutputTokens }),
        stream: true,
        ...(minimalRequest ? {} : { stream_options: { include_usage: true } }),
      } as Parameters<typeof client.chat.completions.create>[0],
      { signal },
    );
  let stream: AsyncIterable<{
    choices: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      prompt_tokens_details?: { cached_tokens?: number } | null;
      completion_tokens_details?: { reasoning_tokens?: number } | null;
      cost?: number;
    } | null;
  }>;
  try {
    stream = await createStream() as unknown as typeof stream;
  } catch (error) {
    const status =
      typeof error === "object" && error && "status" in error
        ? (error as { status?: unknown }).status
        : null;
    if (input.provider !== "custom" || status !== 400) throw error;
    // Some compatible servers implement the core OpenAI chat schema but reject
    // newer optional fields such as reasoning_effort or stream_options.
    stream = await createStream(true) as unknown as typeof stream;
  }

  let receivedText = false;
  let usage: TokenUsage | null = null;
  let finishReason: "length" | "content_filter" | null = null;
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      receivedText = true;
      onDelta(delta);
    }
    const nextFinishReason = chunk.choices[0]?.finish_reason;
    if (nextFinishReason === "length" || nextFinishReason === "content_filter") {
      finishReason = nextFinishReason;
    }
    if (chunk.usage) {
      const providerUsage = chunk.usage as typeof chunk.usage & { cost?: number };
      usage = {
        inputTokens: providerUsage.prompt_tokens,
        cachedInputTokens: providerUsage.prompt_tokens_details?.cached_tokens ?? 0,
        outputTokens: providerUsage.completion_tokens,
        reasoningTokens:
          providerUsage.completion_tokens_details?.reasoning_tokens ?? 0,
        totalTokens: providerUsage.total_tokens,
        ...(typeof providerUsage.cost === "number"
          ? { costUsd: providerUsage.cost }
          : {}),
      };
    }
  }
  ensureVisibleText(receivedText, finishReason);
  return usage;
}

function anthropicThinking(
  effort: ReasoningEffort,
  maxTokens: number,
): { type: "enabled"; budget_tokens: number } | undefined {
  if (effort === "none" || maxTokens < 2_048) return undefined;
  const requested = {
    low: 1_024,
    medium: 4_096,
    high: 10_000,
    xhigh: 32_000,
    max: 64_000,
  }[effort];
  return { type: "enabled", budget_tokens: Math.max(1_024, Math.min(requested, maxTokens - 1_024)) };
}

async function streamAnthropicResponse(
  input: RespondInput,
  instructions: string,
  request: string,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
): Promise<TokenUsage | null> {
  if (!input.apiKey) throw new Error("No Claude API key is configured. Add one in Providers.");
  const maxTokens = input.maxOutputTokens === 0 ? 128_000 : input.maxOutputTokens;
  const thinking = anthropicThinking(input.reasoningEffort, maxTokens);
  const client = new Anthropic({ apiKey: input.apiKey });
  const stream = client.messages.stream(
    {
      model: input.model,
      system: instructions,
      messages: [{ role: "user", content: request }],
      max_tokens: maxTokens,
      ...(thinking ? { thinking } : {}),
    },
    { signal },
  );
  let receivedText = false;
  stream.on("text", (text) => {
    if (!text) return;
    receivedText = true;
    onDelta(text);
  });
  const message = await stream.finalMessage();
  ensureVisibleText(receivedText, message.stop_reason === "max_tokens" ? "length" : null);
  return {
    inputTokens: message.usage.input_tokens,
    cachedInputTokens: message.usage.cache_read_input_tokens ?? 0,
    outputTokens: message.usage.output_tokens,
    reasoningTokens: 0,
    totalTokens: message.usage.input_tokens + message.usage.output_tokens,
  };
}

export async function streamResponse(
  input: RespondInput,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
): Promise<TokenUsage | null> {
  const basePrompt = input.purpose === "visualization"
    ? await readPromptFile(VISUALIZATION_PROMPT_FILE, "VISUALIZATION_PROMPT.md")
    : input.purpose === "rewrite"
      ? await readPromptFile(SOURCE_REWRITE_PROMPT_FILE, "SOURCE_REWRITE_PROMPT.md")
      : await readPromptFile(SYSTEM_PROMPT_FILE, "SYSTEM_PROMPT.md");
  const prompt = buildPrompt(input, basePrompt);
  if (input.provider === "openai") {
    return streamOpenAIResponse(input, prompt.instructions, prompt.request, onDelta, signal);
  }
  if (input.provider === "anthropic") {
    return streamAnthropicResponse(input, prompt.instructions, prompt.request, onDelta, signal);
  }
  return streamCompatibleChat(input, prompt.instructions, prompt.request, onDelta, signal);
}
