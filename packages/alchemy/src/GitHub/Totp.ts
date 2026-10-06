import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";
import * as crypto from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Decode an RFC 4648 base32 string (padding, spaces and dashes are ignored). */
export const decodeBase32 = (encoded: string): Uint8Array => {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of encoded.toUpperCase().replace(/[\s=-]/g, "")) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value === -1) {
      throw new Error(`Invalid base32 character '${char}' in TOTP secret`);
    }
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(bytes);
};

export interface TotpOptions {
  /** @default 6 */
  readonly digits?: number;
  /** Time step in seconds. @default 30 */
  readonly period?: number;
}

/**
 * RFC 6238 TOTP (HMAC-SHA1) for a base32 secret at `now` (epoch
 * milliseconds).
 */
export const totp = (
  secret: Redacted.Redacted<string>,
  now: number,
  options?: TotpOptions,
): Effect.Effect<string> =>
  Effect.sync(() => {
    const digits = options?.digits ?? 6;
    const period = options?.period ?? 30;
    const key = decodeBase32(Redacted.value(secret));
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / period)));
    const digest = crypto.createHmac("sha1", key).update(counter).digest();
    const offset = digest[digest.length - 1]! & 0x0f;
    const binary =
      ((digest[offset]! & 0x7f) << 24) |
      (digest[offset + 1]! << 16) |
      (digest[offset + 2]! << 8) |
      digest[offset + 3]!;
    return String(binary % 10 ** digits).padStart(digits, "0");
  });

const turn = Semaphore.makeUnsafe(1);
let lastStep = -1;

/**
 * The current TOTP code, never the same one twice in this process: GitHub
 * rejects a reused code, so a second request inside the same time step
 * sleeps until the next one.
 */
export const nextUnusedCode = (
  secret: Redacted.Redacted<string>,
  options?: TotpOptions,
): Effect.Effect<string> =>
  turn.withPermits(1)(
    Effect.gen(function* () {
      const period = options?.period ?? 30;
      let now = yield* Clock.currentTimeMillis;
      let step = Math.floor(now / 1000 / period);
      while (step <= lastStep) {
        yield* Effect.sleep(
          Duration.millis((lastStep + 1) * period * 1000 - now),
        );
        now = yield* Clock.currentTimeMillis;
        step = Math.floor(now / 1000 / period);
      }
      lastStep = step;
      return yield* totp(secret, now, options);
    }),
  );
