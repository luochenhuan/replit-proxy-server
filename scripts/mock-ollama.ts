/**
 * Mock Ollama server for load testing the proxy layer in isolation.
 *
 * Real LLM inference caps out far below "hundreds of requests per second" on
 * a laptop, so to measure the PROXY's throughput (auth, limit checks, usage
 * accounting, piping) we substitute a server that responds instantly with
 * an OpenAI-shaped completion. Listens on port 11435 by default.
 */
import Fastify from "fastify";

const port = Number(process.env.MOCK_PORT ?? 11435);
const app = Fastify({ logger: false });

let counter = 0;

app.post("/v1/chat/completions", async (req) => {
  const body = req.body as { model?: string; stream?: boolean };
  return {
    id: `chatcmpl-mock-${++counter}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model ?? "mock",
    choices: [
      { index: 0, message: { role: "assistant", content: "4" }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
  };
});

app.listen({ port, host: "127.0.0.1" }).then(() => {
  console.log(`mock ollama listening on :${port}`);
});
