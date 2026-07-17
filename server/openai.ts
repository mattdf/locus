import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import type { ContextNode, HighlightAnchor, ReasoningEffort } from "../src/types.ts";

let client: OpenAI | null = null;
const SAVED_API_KEY_FILE = path.resolve("data", "openai-api-key.txt");
const PROJECT_API_KEY_FILE = path.resolve("OPENAI_API_KEY.txt");
const SYSTEM_PROMPT_FILE = path.resolve("SYSTEM_PROMPT.md");

export interface ApiKeyStatus {
  configured: boolean;
  source: "saved" | "project-file" | null;
}

function normalizeApiKey(raw: string): string {
  const value = raw.trim();
  const assignment = value.match(/^OPENAI_API_KEY\s*=\s*([\s\S]+)$/);
  return (assignment?.[1] ?? value).trim().replace(/^['"]|['"]$/g, "");
}

async function readKeyFile(file: string): Promise<string | null> {
  try {
    return normalizeApiKey(await readFile(file, "utf8")) || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readApiKey(): Promise<string> {
  const savedKey = await readKeyFile(SAVED_API_KEY_FILE);
  if (savedKey) return savedKey;

  const projectKey = await readKeyFile(PROJECT_API_KEY_FILE);
  if (projectKey) return projectKey;

  throw new Error("No OpenAI API key is configured. Add one in Settings or OPENAI_API_KEY.txt.");
}

export async function getApiKeyStatus(): Promise<ApiKeyStatus> {
  if (await readKeyFile(SAVED_API_KEY_FILE)) {
    return { configured: true, source: "saved" };
  }
  if (await readKeyFile(PROJECT_API_KEY_FILE)) {
    return { configured: true, source: "project-file" };
  }
  return { configured: false, source: null };
}

export async function saveApiKey(raw: string): Promise<ApiKeyStatus> {
  const apiKey = normalizeApiKey(raw);
  if (apiKey.length < 20) throw new Error("Enter a valid OpenAI API key.");

  await mkdir(path.dirname(SAVED_API_KEY_FILE), { recursive: true });
  const temporaryFile =
    SAVED_API_KEY_FILE + "." + process.pid + "." + Date.now() + ".tmp";
  await writeFile(temporaryFile, apiKey + "\n", { encoding: "utf8", mode: 0o600 });
  await rename(temporaryFile, SAVED_API_KEY_FILE);
  client = null;
  return { configured: true, source: "saved" };
}

async function getClient(): Promise<OpenAI> {
  if (!client) client = new OpenAI({ apiKey: await readApiKey() });
  return client;
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
}

export async function streamResponse(
  input: RespondInput,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
): Promise<TokenUsage | null> {
  const [openai, systemPrompt] = await Promise.all([getClient(), readSystemPrompt()]);
  const highlighted = input.anchor
    ? `\n\nThe learner selected this exact passage:\n<highlighted_passage>\n${input.anchor.quote}\n</highlighted_passage>`
    : "";

  const customInstructions = input.customInstructions.trim()
    ? `\n\nThe learner also supplied these additional behavior preferences. Follow them where compatible with the tutoring instructions above; they supplement rather than replace the tutoring role:\n<custom_instructions>\n${input.customInstructions.trim()}\n</custom_instructions>`
    : "";
  const stream = await openai.responses.create(
    {
      model: input.model,
      instructions: systemPrompt + customInstructions,
      input: `Here is the complete path of conversation context:\n\n${formatContext(input.context)}${highlighted}\n\n<learner_request>\n${input.message}\n</learner_request>`,
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
  if (!receivedText) {
    if (incompleteReason === "max_output_tokens") {
      throw new Error("The model exhausted the output-token limit before producing visible text");
    }
    if (incompleteReason === "content_filter") {
      throw new Error("The model returned no text because the response was filtered");
    }
    throw new Error("The model returned no text");
  }
  return usage;
}
