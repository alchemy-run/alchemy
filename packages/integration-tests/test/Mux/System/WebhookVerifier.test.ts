import { createHmac } from "node:crypto";
import * as Mux from "@alchemy.run/mux";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Mux.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

/** Mux's scheme, built with Node's HMAC rather than the WebCrypto code under test. */
const muxSignature = (secret: string, body: string, t: number) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

// The deployed-host path is `test/Mux/Bindings.test.ts`; this pins the
// signature check itself against a real webhook's signing secret.
test.provider(
  "verifyWebhookSignature accepts Mux's scheme and rejects tampered, foreign, stale and missing signatures",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const hook = yield* stack.deploy(
        Mux.System.Webhook("Hook", {
          address: `https://alchemy-test.example.com/mux/verifier-${stack.stage}`,
        }),
      );
      const secret = Redacted.value(hook.signing_secret);
      expect(secret.length).toBeGreaterThanOrEqual(16);

      const body = JSON.stringify({ type: "video.asset.ready", data: { id: "asset" } });
      const now = Math.floor(Date.now() / 1000);
      const verify = (raw: string, header: string | undefined) =>
        Effect.promise(() => Mux.System.verifyWebhookSignature(secret, raw, header, { now }));

      expect(yield* verify(body, muxSignature(secret, body, now))).toBeUndefined();
      expect(
        yield* verify(body, `${muxSignature(secret, body, now)},v1=${"0".repeat(64)}`),
      ).toBeUndefined();
      expect(yield* verify(body.replace("ready", "errored"), muxSignature(secret, body, now))).toBe(
        "signature mismatch",
      );
      expect(yield* verify(body, muxSignature("not-the-secret", body, now))).toBe(
        "signature mismatch",
      );
      expect(yield* verify(body, muxSignature(secret, body, now - 600))).toBe(
        "timestamp outside tolerance",
      );
      expect(yield* verify(body, undefined)).toBe("missing mux-signature header");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:mux", "provider:mux:system", "live"], timeout: 120_000 },
);
