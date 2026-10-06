import * as SDK from "@distilled.cloud/openrouter";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as OpenRouter from "@/OpenRouter";
import * as Test from "@/Test/Alchemy";

const { test } = Test.make({ providers: OpenRouter.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

class KeyStillExists extends Data.TaggedError("KeyStillExists")<{ hash: string }> {}

/** Typed wait-until-gone: getKey must settle on `NotFound`. */
const waitForKeyDeleted = (hash: string) =>
  SDK.getKey({ hash }).pipe(
    Effect.flatMap(() => Effect.fail(new KeyStillExists({ hash }))),
    Effect.retry({
      while: (e) => e._tag === "KeyStillExists",
      schedule: Schedule.spaced("1 second"),
      times: 10,
    }),
    Effect.catchTag("NotFound", () => Effect.void),
  );

const observeKey = (hash: string) =>
  SDK.getKey({ hash }).pipe(Effect.map((response) => response.data));

describe.skipIf(!process.env.OPENROUTER_MANAGEMENT_KEY)(
  "OpenRouter.ApiKey",
  { tags: ["provider:openrouter", "provider:openrouter:apikey", "live"] },
  () => {
    test.provider(
      "create, update the budget in place, disable, clear and delete",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          // Create with a daily budget.
          const created = yield* stack.deploy(
            OpenRouter.ApiKey("BudgetKey", { limit: 1, limitReset: "daily" }),
          );
          expect(created.hash).toBeTruthy();
          expect(Redacted.value(created.key)).toMatch(/^sk-or-/);
          expect(created.limit).toBe(1);
          expect(created.limitReset).toBe("daily");
          expect(created.disabled).toBe(false);

          const live = yield* observeKey(created.hash);
          expect(live.name).toBe(created.name);
          expect(live.limit).toBe(1);
          expect(live.limit_reset).toBe("daily");

          // Raise the budget, change the window and disable — all in place:
          // the hash and the reveal-once secret are preserved.
          const updated = yield* stack.deploy(
            OpenRouter.ApiKey("BudgetKey", {
              limit: 2.5,
              limitReset: "weekly",
              disabled: true,
            }),
          );
          expect(updated.hash).toBe(created.hash);
          expect(Redacted.value(updated.key)).toBe(Redacted.value(created.key));
          const liveUpdated = yield* observeKey(created.hash);
          expect(liveUpdated.limit).toBe(2.5);
          expect(liveUpdated.limit_reset).toBe("weekly");
          expect(liveUpdated.disabled).toBe(true);

          // Removing the props clears the limit and re-enables the key.
          const cleared = yield* stack.deploy(OpenRouter.ApiKey("BudgetKey", {}));
          expect(cleared.hash).toBe(created.hash);
          const liveCleared = yield* observeKey(created.hash);
          expect(liveCleared.limit).toBeNull();
          expect(liveCleared.limit_reset).toBeNull();
          expect(liveCleared.disabled).toBe(false);

          yield* stack.destroy();
          yield* waitForKeyDeleted(created.hash);
        }).pipe(logLevel),
      { timeout: 120_000 },
    );

    test.provider(
      "renames in place and replaces when expiresAt changes",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const first = yield* stack.deploy(
            OpenRouter.ApiKey("ExpiringKey", {
              name: "alchemy-openrouter-expiring",
              limit: 1,
              expiresAt: "2099-01-01T00:00:00Z",
            }),
          );

          const renamed = yield* stack.deploy(
            OpenRouter.ApiKey("ExpiringKey", {
              name: "alchemy-openrouter-expiring-renamed",
              limit: 1,
              expiresAt: "2099-01-01T00:00:00Z",
            }),
          );
          expect(renamed.hash).toBe(first.hash);
          expect((yield* observeKey(first.hash)).name).toBe("alchemy-openrouter-expiring-renamed");

          // A new expiry can only be set at creation: replacement mints a new
          // key and deletes the old one.
          const replaced = yield* stack.deploy(
            OpenRouter.ApiKey("ExpiringKey", {
              name: "alchemy-openrouter-expiring-renamed",
              limit: 1,
              expiresAt: "2098-01-01T00:00:00Z",
            }),
          );
          expect(replaced.hash).not.toBe(first.hash);
          expect(Redacted.value(replaced.key)).not.toBe(Redacted.value(first.key));
          yield* waitForKeyDeleted(first.hash);
          expect(Date.parse((yield* observeKey(replaced.hash)).expires_at ?? "")).toBe(
            Date.parse("2098-01-01T00:00:00Z"),
          );

          yield* stack.destroy();
          yield* waitForKeyDeleted(replaced.hash);
        }).pipe(logLevel),
      { timeout: 120_000 },
    );

    test.provider(
      "recreates a key deleted out of band",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const original = yield* stack.deploy(OpenRouter.ApiKey("DriftKey", { limit: 1 }));
          yield* SDK.deleteKey({ hash: original.hash });
          yield* waitForKeyDeleted(original.hash);

          // Observation finds the key missing and the reconciler recreates it.
          const recreated = yield* stack.deploy(OpenRouter.ApiKey("DriftKey", { limit: 2 }));
          expect(recreated.hash).not.toBe(original.hash);
          expect((yield* observeKey(recreated.hash)).limit).toBe(2);

          yield* stack.destroy();
          yield* waitForKeyDeleted(recreated.hash);
        }).pipe(logLevel),
      { timeout: 120_000 },
    );
  },
);
