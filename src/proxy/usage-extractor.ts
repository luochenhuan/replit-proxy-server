import type { Usage } from "../types.js";

/**
 * Extracts token usage from OpenAI-compatible responses.
 *
 * Non-streaming: usage sits at the top level of the JSON body.
 *
 * Streaming: usage arrives in a terminal SSE chunk (the proxy injects
 * `stream_options.include_usage` into server requests to guarantee this).
 * The extractor observes the byte stream as it is piped through to the
 * client — it never buffers the whole response, only the current partial
 * SSE event line, so memory stays O(single event) regardless of stream size.
 */

export function usageFromJson(body: unknown): Usage | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const usage = (body as { usage?: unknown }).usage;
  return normalizeUsage(usage);
}

function normalizeUsage(usage: unknown): Usage | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;
  const u = usage as Record<string, unknown>;
  const prompt = typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0;
  const completion = typeof u.completion_tokens === "number" ? u.completion_tokens : 0;
  const total = typeof u.total_tokens === "number" ? u.total_tokens : prompt + completion;
  if (prompt === 0 && completion === 0 && total === 0) return undefined;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

/**
 * Incremental SSE scanner. Feed it raw bytes as they stream through; it
 * splits on newlines, inspects `data:` lines, and remembers the last usage
 * object seen. Handles events split across arbitrary chunk boundaries.
 */
export class SseUsageScanner {
  private buffer = "";
  private latest: Usage | undefined;
  /** Guard against a pathological server never sending a newline. */
  private static readonly MAX_LINE_BYTES = 1_048_576;

  feed(chunk: Buffer | string): void {
    this.buffer += chunk.toString();
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.inspectLine(line);
    }
    if (this.buffer.length > SseUsageScanner.MAX_LINE_BYTES) {
      this.buffer = "";
    }
  }

  /** The most recent usage payload observed, if any. */
  usage(): Usage | undefined {
    return this.latest;
  }

  private inspectLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (payload === "" || payload === "[DONE]") return;
    // Cheap pre-filter: skip JSON.parse for the many delta chunks with no usage.
    if (!payload.includes('"usage"')) return;
    try {
      const parsed = JSON.parse(payload) as unknown;
      const usage = usageFromJson(parsed);
      if (usage) this.latest = usage;
    } catch {
      // Malformed event — ignore; billing falls back to "no usage observed".
    }
  }
}
