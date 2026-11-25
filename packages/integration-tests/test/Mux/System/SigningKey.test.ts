import { createPrivateKey } from "node:crypto";
import * as Mux from "@alchemy.run/mux";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as System from "@distilled.cloud/mux/system";
import * as Drift from "alchemy/Drift";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: Mux.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// GET on a deleted key can answer 200 for minutes; the list is accurate.
const listed = (id: string) =>
  System.listSigningKeys.items({ limit: 100 }).pipe(
    Stream.runCollect,
    Effect.map((keys) => keys.some((key) => key.id === id)),
  );

const waitUntilGone = (id: string) =>
  listed(id).pipe(
    Effect.map((found) => (found ? "found" : "gone")),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const rsaKeyType = (privateKey: Redacted.Redacted<string>) =>
  Effect.try(
    () =>
      createPrivateKey(Buffer.from(Redacted.value(privateKey), "base64").toString("utf8"))
        .asymmetricKeyType,
  );

test.provider(
  "create a signing key, keep it across deploys, and delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(Mux.System.SigningKey("Key"));
      expect(yield* rsaKeyType(created.private_key)).toEqual("rsa");
      expect(yield* listed(created.id)).toBe(true);

      const again = yield* stack.deploy(Mux.System.SigningKey("Key"));
      expect(again.id).toEqual(created.id);
      expect(Redacted.value(again.private_key)).toEqual(Redacted.value(created.private_key));

      yield* stack.destroy();
      expect(yield* waitUntilGone(created.id)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:mux", "provider:mux:system", "live"], timeout: 120_000 },
);

test.provider(
  "drift repair creates a new key when the key is deleted outside Alchemy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(Mux.System.SigningKey("Key"));
      // Read it first: this is what makes GET keep answering 200 after the delete.
      yield* System.getSigningKey({ SIGNING_KEY_ID: first.id });
      yield* System.deleteSigningKey({ SIGNING_KEY_ID: first.id });

      const drift = yield* Drift.detect(stack).pipe(Effect.provide(stack.state));
      expect(drift.resources.Key?.action).toBe("missing");
      yield* Drift.repair(stack).pipe(Effect.provide(stack.state));

      const second = yield* stack.deploy(Mux.System.SigningKey("Key"));
      expect(second.id).not.toEqual(first.id);
      expect(yield* listed(second.id)).toBe(true);
      expect(yield* rsaKeyType(second.private_key)).toEqual("rsa");

      yield* stack.destroy();
      expect(yield* waitUntilGone(second.id)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:mux", "provider:mux:system", "live"], timeout: 120_000 },
);
