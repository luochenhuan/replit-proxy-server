import { createHash } from "node:crypto";

/**
 * API-key authentication.
 *
 * Design decision: for this exercise any non-empty bearer token is accepted
 * and the user's identity IS the token (hashed for log/API safety). This
 * mirrors how the real system would look after swapping `identify` for a
 * key-database lookup — the rest of the codebase only ever sees a `userId`.
 */
export interface Identity {
  userId: string;
}

/** Extract the bearer token from an Authorization header value. */
export function parseBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || undefined;
}

/**
 * Map an API token to a stable user id. Hashing means raw keys never appear
 * in logs, metrics, or admin API responses.
 */
export function identify(token: string): Identity {
  const digest = createHash("sha256").update(token).digest("hex");
  return { userId: `user_${digest.slice(0, 16)}` };
}
