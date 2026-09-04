/**
 * Byte helpers — the ONE place for bytes ↔ base64 and buffer joins.
 * Base64 delegates to `effect/Encoding` (standard alphabet, padded —
 * what `btoa`/`Buffer.toString("base64")` produce, so wire formats
 * written by either side of an older version still read).
 */
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";

/** Bytes → standard (padded) base64. */
export const toBase64 = (bytes: Uint8Array): string =>
  Encoding.encodeBase64(bytes);

/**
 * Standard base64 → bytes. THROWS on malformed input: this is for
 * payloads we produced ourselves (RPC frames, PTY output, API bodies
 * the server encoded), where a bad string is a protocol bug, not an
 * input to validate. Untrusted text goes through
 * `Encoding.decodeBase64` and handles the `Result`.
 */
export const fromBase64 = (b64: string): Uint8Array =>
  Result.getOrThrow(Encoding.decodeBase64(b64));

/** Join byte chunks into one contiguous buffer. */
export const concatBytes = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};
