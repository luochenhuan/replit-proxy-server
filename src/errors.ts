/**
 * OpenAI-style error envelope so SDK clients surface proxy errors the same
 * way they surface real API errors (e.g. openai.RateLimitError on 429).
 */
export function openAiError(message: string, code: string, status: number) {
  return {
    error: {
      message,
      type: status === 429 ? "rate_limit_error" : status >= 500 ? "api_error" : "invalid_request_error",
      code,
      param: null,
    },
  };
}
