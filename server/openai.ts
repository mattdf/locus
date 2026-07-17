import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  ContextNode,
  HighlightAnchor,
  ProviderId,
  ReasoningEffort,
} from "../src/types.ts";
import {
  createProviderClient,
  getProviderStatus,
  saveProviderApiKey,
  type ProviderCredentialStatus,
} from "./providers.ts";

const SYSTEM_PROMPT_FILE = path.resolve("SYSTEM_PROMPT.md");

export async function getApiKeyStatus(): Promise<ProviderCredentialStatus> {
  return getProviderStatus("openai");
}

export async function saveApiKey(raw: string): Promise<ProviderCredentialStatus> {
  return saveProviderApiKey("openai", raw);
}

async function readSystemPrompt(): Promise<string> {
  const prompt = (await readFile(SYSTEM_PROMPT_FILE, "utf8")).trim();
  if (!prompt) throw new Error("SYSTEM_PROMPT.md is empty");
  return prompt;
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
  provider: ProviderId;
  localBaseUrl?: string;
  model: string;
  context: ContextNode[];
  message: string;
  reasoningEffort: ReasoningEffort;
  maxOutputTokens: number;
  customInstructions: string;
  anchor?: HighlightAnchor;
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd?: number;
}

function buildPrompt(input: RespondInput, systemPrompt: string) {
  const highlighted = input.anchor
    ? `\n\nThe learner selected this exact passage:\n<highlighted_passage>\n${input.anchor.quote}\n</highlighted_passage>`
    : "";
  const customInstructions = input.customInstructions.trim()
    ? `\n\nThe learner also supplied these additional behavior preferences. Follow them where compatible with the tutoring instructions above; they supplement rather than replace the tutoring role:\n<custom_instructions>\n${input.customInstructions.trim()}\n</custom_instructions>`
    : "";
  return {
    instructions: systemPrompt + customInstructions,
    request: `Here is the complete path of conversation context:\n\n${formatContext(input.context)}${highlighted}\n\n<learner_request>\n${input.message}\n</learner_request>`,
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
  const openai = await createProviderClient("openai");
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
  const client = await createProviderClient(input.provider, input.localBaseUrl);
  const messages = [
    { role: "system" as const, content: instructions },
    { role: "user" as const, content: request },
  ];
  const createStream = (minimalLocalRequest = false) =>
    client.chat.completions.create(
      {
        model: input.model,
        messages,
        ...(minimalLocalRequest ? {} : { reasoning_effort: input.reasoningEffort }),
        ...(input.maxOutputTokens === 0
          ? {}
          : input.provider === "local"
            ? { max_tokens: input.maxOutputTokens }
            : { max_completion_tokens: input.maxOutputTokens }),
        stream: true,
        ...(minimalLocalRequest ? {} : { stream_options: { include_usage: true } }),
      },
      { signal },
    );
  let stream;
  try {
    stream = await createStream();
  } catch (error) {
    const status =
      typeof error === "object" && error && "status" in error
        ? (error as { status?: unknown }).status
        : null;
    if (input.provider !== "local" || status !== 400) throw error;
    // Older local servers often implement the core OpenAI chat schema but reject
    // newer optional fields such as reasoning_effort or stream_options.
    stream = await createStream(true);
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

export async function streamResponse(
  input: RespondInput,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
): Promise<TokenUsage | null> {
  const systemPrompt = await readSystemPrompt();
  const prompt = buildPrompt(input, systemPrompt);
  return input.provider === "openai"
    ? streamOpenAIResponse(input, prompt.instructions, prompt.request, onDelta, signal)
    : streamCompatibleChat(input, prompt.instructions, prompt.request, onDelta, signal);
}
