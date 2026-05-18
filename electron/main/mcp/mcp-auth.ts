/**
 * mcp-auth.ts — Bearer-token authentication for the local MCP server.
 *
 * The MCP server listens on a loopback TCP port, which is reachable by any
 * local process. A random bearer token, minted once and then persisted in
 * the config store, gates every request so that only the agent the user
 * explicitly configured can drive the kernel. It is shown to the user in
 * Settings → Agents. Persistence is handled by the server (see
 * `resolvePersistedToken` in `mcp-server.ts`); this module only mints and
 * verifies tokens.
 *
 * This is a local handshake secret, not a vendor credential — PDV stores no
 * account information (ARCHITECTURE.md §15.4).
 *
 * See Also
 * --------
 * ARCHITECTURE.md §15.4 — Authentication
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * Generate a fresh random bearer token.
 *
 * @returns A URL-safe base64 string carrying 256 bits of entropy.
 */
export function generateBearerToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Constant-time string comparison, safe against timing side channels.
 *
 * @param a - First string.
 * @param b - Second string.
 * @returns True when the strings are byte-for-byte equal.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Check whether an incoming HTTP request carries the expected bearer token.
 *
 * @param req - The incoming HTTP request.
 * @param token - The server's current bearer token.
 * @returns True when the request's `Authorization: Bearer …` header matches.
 */
export function requestHasValidToken(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string") {
    return false;
  }
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) {
    return false;
  }
  return constantTimeEqual(header.slice(prefix.length).trim(), token);
}
