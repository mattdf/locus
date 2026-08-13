import { createServer } from "node:http";
import { once } from "node:events";
import {
  createGeneration,
  getGenerationSnapshot,
} from "../../server/generations.ts";

const server = createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  request.resume();
  request.once("end", () => {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    response.write(
      `data: ${JSON.stringify({
        id: "detached-test",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "detached-test-model",
        choices: [
          {
            index: 0,
            delta: { content: "background job completed" },
            finish_reason: null,
          },
        ],
      })}\n\n`,
    );
    setTimeout(() => {
      response.write(
        `data: ${JSON.stringify({
          id: "detached-test",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "detached-test-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 7,
            completion_tokens: 3,
            total_tokens: 10,
          },
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    }, 30);
  });
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("Mock provider did not bind");

const owner = "detachment-test-owner";
const requestId = `detachment-test-${Date.now()}`;
createGeneration(owner, requestId, {
  provider: "custom",
  providerLabel: "Detached test provider",
  baseUrl: `http://127.0.0.1:${address.port}/v1`,
  apiKey: "detachment-test-key",
  model: "detached-test-model",
  context: [],
  message: "Complete in the background",
  reasoningEffort: "none",
  maxOutputTokens: 100,
  customInstructions: "",
  purpose: "chat",
});

// Intentionally never attach a streaming subscriber. The upstream job must
// still complete, and a later observer must recover the terminal snapshot.
let snapshot = await getGenerationSnapshot(owner, requestId);
for (let attempt = 0; snapshot?.status === "running" && attempt < 100; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 10));
  snapshot = await getGenerationSnapshot(owner, requestId);
}

server.close();
if (snapshot?.status !== "completed") {
  throw new Error(`Detached generation ended as ${snapshot?.status ?? "missing"}`);
}
if (snapshot.content !== "background job completed") {
  throw new Error(`Unexpected detached content: ${JSON.stringify(snapshot.content)}`);
}
if (snapshot.generation?.totalTokens !== 10) {
  throw new Error("Detached generation usage was not retained");
}
console.log("Detached generation completed and was recovered from status.");
