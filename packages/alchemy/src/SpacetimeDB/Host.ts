import * as Effect from "effect/Effect";
import { AuthError } from "../Auth/AuthProvider.ts";
import { getEnv } from "../Auth/Env.ts";

/**
 * Default Maincloud host used when no host is configured.
 *
 * @see https://spacetimedb.com/docs/how-to/deploy/maincloud
 */
export const DEFAULT_HOST = "https://maincloud.spacetimedb.com";

/**
 * Normalize a SpacetimeDB host nickname or URL into an absolute HTTPS origin.
 *
 * - bare nicknames like `maincloud` → `https://maincloud.spacetimedb.com`
 * - bare hostnames → `https://…`
 * - full URLs keep their origin (scheme + host + port), stripping any path
 */
export const normalizeHost = (
  input: string,
): Effect.Effect<string, AuthError> =>
  Effect.try({
    try: () => {
      const trimmed = input.trim().replace(/\/+$/, "");
      if (trimmed.length === 0) {
        throw new Error("empty");
      }
      if (trimmed === "maincloud" || trimmed === "maincloud.spacetimedb.com") {
        return DEFAULT_HOST;
      }
      if (trimmed === "local" || trimmed === "localhost") {
        return "http://127.0.0.1:3000";
      }
      const withScheme = trimmed.includes("://")
        ? trimmed
        : `https://${trimmed}`;
      const url = new URL(withScheme);
      // SpacetimeDB API is served at the origin root (`/v1/...`).
      return url.origin;
    },
    catch: () =>
      new AuthError({
        message: `Invalid SpacetimeDB host: '${input}'. Provide a nickname (maincloud), hostname, or URL (https://maincloud.spacetimedb.com).`,
      }),
  });

/**
 * Resolve the SpacetimeDB host from the environment.
 *
 * Precedence: `SPACETIMEDB_HOST` → `SPACETIME_HOST` → `SPACETIMEDB_SERVER` →
 * default Maincloud.
 */
export const resolveHostFromEnv: Effect.Effect<string, AuthError> = Effect.gen(
  function* () {
    for (const key of [
      "SPACETIMEDB_HOST",
      "SPACETIME_HOST",
      "SPACETIMEDB_SERVER",
    ] as const) {
      const value = yield* getEnv(key);
      if (value) return yield* normalizeHost(value);
    }
    return DEFAULT_HOST;
  },
);

/**
 * Convert an HTTP(S) SpacetimeDB host into the WebSocket URI clients pass to
 * `DbConnection.builder().withUri(...)`.
 */
export const toWebSocketUri = (host: string): string => {
  const url = new URL(host);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.origin;
};

/**
 * Dashboard URL for a database on Maincloud, or `undefined` when the host
 * has no browser UI (local standalone / unknown self-hosted).
 *
 * Maincloud: `https://spacetimedb.com/<name>`.
 */
export const dashboardUrl = (
  databaseName: string,
  host: string,
): string | undefined => {
  let origin: string;
  try {
    origin = new URL(host).origin;
  } catch {
    return undefined;
  }
  if (
    origin === DEFAULT_HOST ||
    origin.endsWith(".spacetimedb.com") ||
    origin.includes("maincloud")
  ) {
    return `https://spacetimedb.com/${databaseName}`;
  }
  return undefined;
};
