/**
 * End-to-end verification against a running proxy (default http://localhost:8000)
 * backed by a real Ollama server, using the official `openai` client — exactly
 * how a Replit user's app would call the service.
 *
 * Covers: basic chat completion, streaming, vision (moondream), the usage
 * API, and admin-configured limit enforcement (429s).
 *
 * Usage: ADMIN_API_KEY=admin-secret npm run test:e2e
 */
import OpenAI from "openai";

const PROXY = process.env.PROXY_URL ?? "http://localhost:8000";
const ADMIN_KEY = process.env.ADMIN_API_KEY ?? "admin-secret";
const USER_KEY = `e2e-user-${process.pid}`; // fresh identity per run

const client = new OpenAI({ baseURL: `${PROXY}/v1`, apiKey: USER_KEY, maxRetries: 0 });

let failures = 0;

function check(name: string, ok: boolean, detail?: string) {
  const mark = ok ? "PASS" : "FAIL";
  if (!ok) failures++;
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function adminFetch(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${ADMIN_KEY}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${PROXY}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any — test script inspects loose JSON shapes
async function userFetch(path: string): Promise<any> {
  const res = await fetch(`${PROXY}${path}`, {
    headers: { authorization: `Bearer ${USER_KEY}` },
  });
  return res.json();
}

async function main() {
  // 1. Basic chat completion (the exact example from the prompt).
  const response = await client.chat.completions.create({
    model: "llama3.2:1b",
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "What is 2+2?" },
    ],
    temperature: 0.7,
    max_tokens: 100,
  });
  const answer = response.choices[0]?.message?.content ?? "";
  check("basic chat completion", answer.length > 0, `answer=${JSON.stringify(answer.slice(0, 60))}`);
  check("completion reports usage", (response.usage?.total_tokens ?? 0) > 0, `usage=${JSON.stringify(response.usage)}`);

  // 2. Streaming completion.
  const stream = await client.chat.completions.create({
    model: "llama3.2:1b",
    messages: [{ role: "user", content: "Count from 1 to 5." }],
    stream: true,
  });
  let streamed = "";
  let chunkCount = 0;
  for await (const chunk of stream) {
    chunkCount++;
    streamed += chunk.choices[0]?.delta?.content ?? "";
  }
  check("streaming completion", chunkCount > 1 && streamed.length > 0, `${chunkCount} chunks`);

  // 3. Vision with moondream, image from Lorem Picsum.
  const imgRes = await fetch("https://picsum.photos/seed/proxytest/300/200.jpg");
  const imgB64 = Buffer.from(await imgRes.arrayBuffer()).toString("base64");
  const vision = await client.chat.completions.create({
    model: "moondream",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this image in one sentence." },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imgB64}` } },
        ],
      },
    ],
    max_tokens: 120,
  });
  const visionAnswer = vision.choices[0]?.message?.content ?? "";
  check("vision (moondream)", visionAnswer.length > 0, JSON.stringify(visionAnswer.slice(0, 80)));

  // 4. Usage API reflects all of the above, per model.
  const usage = await userFetch("/v1/usage");
  const llamaTokens = usage.models?.["llama3.2:1b"]?.total_tokens ?? 0;
  const moonTokens = usage.models?.["moondream"]?.total_tokens ?? 0;
  check("usage API tracks llama3.2:1b", llamaTokens > 0, `${llamaTokens} tokens`);
  check("usage API tracks moondream", moonTokens > 0, `${moonTokens} tokens`);
  check(
    "usage API tracks streamed usage",
    (usage.models?.["llama3.2:1b"]?.requests ?? 0) >= 2,
    `${usage.models?.["llama3.2:1b"]?.requests} llama requests recorded`,
  );

  // 5. Admin sets a request rate limit; the next request must 429.
  const userId = usage.user_id;
  const putRes = await adminFetch("PUT", `/admin/limits/${userId}`, {
    shortTerm: { windowSeconds: 60, maxRequests: 1 },
  });
  check("admin can set limits", putRes.status === 200);

  // First request after the limit was set fills the 1-request window.
  await client.chat.completions.create({
    model: "llama3.2:1b",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 5,
  });

  let got429 = false;
  try {
    await client.chat.completions.create({
      model: "llama3.2:1b",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 5,
    });
  } catch (err) {
    got429 = err instanceof OpenAI.RateLimitError;
  }
  check("rate limit produces OpenAI RateLimitError (429)", got429);

  // 6. Removing the limit restores service.
  const delRes = await adminFetch("DELETE", `/admin/limits/${userId}`);
  check("limit deletion accepted", delRes.status === 204);
  const after = await client.chat.completions.create({
    model: "llama3.2:1b",
    messages: [{ role: "user", content: "Say OK." }],
    max_tokens: 5,
  });
  check("service restored after limit removal", (after.choices[0]?.message?.content ?? "").length > 0);

  // 7. Admin usage overview includes this user.
  const adminUsage = (await (await adminFetch("GET", "/admin/usage")).json()) as {
    users?: Array<{ user_id: string }>;
  };
  const found = adminUsage.users?.some((u: { user_id: string }) => u.user_id === userId);
  check("admin usage overview lists the user", !!found);

  console.log(failures === 0 ? "\nAll e2e checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("e2e run failed:", err);
  process.exit(1);
});
