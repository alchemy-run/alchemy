import { decodeBase32, nextUnusedCode, totp } from "@/GitHub/Totp.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";

// RFC 6238 Appendix B: the SHA-1 secret "12345678901234567890" in base32.
const secret = Redacted.make("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");

const vectors: ReadonlyArray<readonly [seconds: number, code: string]> = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

describe("GitHub TOTP", { tags: ["unit", "local"] }, () => {
  it("decodes the RFC 6238 base32 secret", () => {
    expect(Buffer.from(decodeBase32(Redacted.value(secret))).toString()).toBe(
      "12345678901234567890",
    );
    expect(Buffer.from(decodeBase32("gezd gnbv-gy3tqojq====")).toString()).toBe(
      "1234567890",
    );
  });

  for (const [seconds, code] of vectors) {
    it.effect(`matches the RFC 6238 SHA-1 vector at T=${seconds}`, () =>
      Effect.gen(function* () {
        expect(yield* totp(secret, seconds * 1000, { digits: 8 })).toBe(code);
        expect(yield* totp(secret, seconds * 1000)).toBe(code.slice(-6));
      }),
    );
  }

  it.effect("is constant within a time step", () =>
    Effect.gen(function* () {
      expect(yield* totp(secret, 30_000)).toBe(yield* totp(secret, 59_999));
      expect(yield* totp(secret, 59_999)).not.toBe(yield* totp(secret, 60_000));
    }),
  );

  it.effect("never hands out the same code twice", () =>
    Effect.gen(function* () {
      const first = yield* nextUnusedCode(secret);
      expect(first).toBe(yield* totp(secret, 0));
      const waiting = yield* Effect.forkChild(nextUnusedCode(secret));
      yield* TestClock.adjust("30 seconds");
      const second = yield* Fiber.join(waiting);
      expect(second).toBe(yield* totp(secret, 30_000));
      expect(second).not.toBe(first);
    }),
  );
});
