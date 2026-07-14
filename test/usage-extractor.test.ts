import { describe, expect, it } from "vitest";
import { SseUsageScanner, usageFromJson } from "../src/proxy/usage-extractor.js";

describe("usageFromJson", () => {
  it("extracts usage from a completion response", () => {
    expect(
      usageFromJson({ usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }),
    ).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
  });

  it("computes total when missing", () => {
    expect(usageFromJson({ usage: { prompt_tokens: 5, completion_tokens: 7 } })).toEqual({
      inputTokens: 5,
      outputTokens: 7,
      totalTokens: 12,
    });
  });

  it("returns undefined for absent or empty usage", () => {
    expect(usageFromJson({})).toBeUndefined();
    expect(usageFromJson(null)).toBeUndefined();
    expect(usageFromJson({ usage: {} })).toBeUndefined();
  });
});

describe("SseUsageScanner", () => {
  const usageChunk = JSON.stringify({
    choices: [],
    usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
  });

  it("finds usage in a terminal SSE chunk", () => {
    const scanner = new SseUsageScanner();
    scanner.feed('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    scanner.feed(`data: ${usageChunk}\n\n`);
    scanner.feed("data: [DONE]\n\n");
    expect(scanner.usage()).toEqual({ inputTokens: 11, outputTokens: 22, totalTokens: 33 });
  });

  it("handles events split across arbitrary chunk boundaries", () => {
    const scanner = new SseUsageScanner();
    const event = `data: ${usageChunk}\n\ndata: [DONE]\n\n`;
    // Feed one byte at a time — worst-case fragmentation.
    for (const ch of event) scanner.feed(ch);
    expect(scanner.usage()).toEqual({ inputTokens: 11, outputTokens: 22, totalTokens: 33 });
  });

  it("returns undefined when no usage chunk ever arrives", () => {
    const scanner = new SseUsageScanner();
    scanner.feed('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
    expect(scanner.usage()).toBeUndefined();
  });

  it("ignores malformed JSON without throwing", () => {
    const scanner = new SseUsageScanner();
    scanner.feed('data: {"usage": not-json}\n\n');
    scanner.feed(`data: ${usageChunk}\n\n`);
    expect(scanner.usage()?.totalTokens).toBe(33);
  });

  it("keeps the last usage seen when multiple appear", () => {
    const scanner = new SseUsageScanner();
    scanner.feed('data: {"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n');
    scanner.feed(`data: ${usageChunk}\n`);
    expect(scanner.usage()?.totalTokens).toBe(33);
  });
});
