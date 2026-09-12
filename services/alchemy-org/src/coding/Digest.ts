import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";

/**
 * SHA-256 hex digest of a file's text content — the tool-layer
 * compare-and-swap token: readFile returns it, editFile/writeFile
 * demand it back to prove the caller is changing the version it
 * actually read. Computed over the UTF-8 bytes of the content string
 * on BOTH sides, so it is stable across any {@link Sandbox} placement.
 */
export const sha256Hex = (content: string): Effect.Effect<string> =>
  Effect.sync(() => createHash("sha256").update(content).digest("hex"));
