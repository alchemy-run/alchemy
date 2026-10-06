import * as SDK from "@distilled.cloud/openrouter";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as OpenRouter from "@/OpenRouter";
import * as Test from "@/Test/Alchemy";

const { test } = Test.make({ providers: OpenRouter.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

class GuardrailStillExists extends Data.TaggedError("GuardrailStillExists")<{ id: string }> {}

/** Typed wait-until-gone: getGuardrail must settle on `GuardrailNotFound`. */
const waitForGuardrailDeleted = (id: string) =>
  SDK.getGuardrail({ id }).pipe(
    Effect.flatMap(() => Effect.fail(new GuardrailStillExists({ id }))),
    Effect.retry({
      while: (e) => e._tag === "GuardrailStillExists",
      schedule: Schedule.spaced("1 second"),
      times: 10,
    }),
    Effect.catchTag("GuardrailNotFound", () => Effect.void),
  );

const assignedKeys = (id: string) =>
  SDK.listGuardrailKeyAssignments({ id, limit: 100 }).pipe(
    Effect.map((response) => response.data.map((assignment) => assignment.key_hash).sort()),
  );

describe.skipIf(!process.env.OPENROUTER_MANAGEMENT_KEY)(
  "OpenRouter.Guardrail",
  { tags: ["provider:openrouter", "provider:openrouter:guardrail", "live"] },
  () => {
    test.provider(
      "create, update policy and key assignments in place, delete",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          // Keep both keys deployed across every step so assignment changes
          // never coincide with a key deletion.
          const deployPolicy = (
            policy: Omit<OpenRouter.GuardrailProps, "apiKeys">,
            assign: ReadonlyArray<"a" | "b">,
          ) =>
            stack.deploy(
              Effect.gen(function* () {
                const a = yield* OpenRouter.ApiKey("AgentA", { limit: 1, limitReset: "daily" });
                const b = yield* OpenRouter.ApiKey("AgentB", { limit: 1, limitReset: "daily" });
                const hashes = { a: a.hash, b: b.hash };
                const guardrail = yield* OpenRouter.Guardrail("Policy", {
                  ...policy,
                  apiKeys: assign.map((key) => hashes[key]),
                });
                return { a, b, guardrail };
              }),
            );

          const first = yield* deployPolicy(
            {
              description: "alchemy guardrail test",
              allowedProviders: ["openai"],
              limitUsd: 1,
              resetInterval: "daily",
            },
            ["a"],
          );
          expect(first.guardrail.allowedProviders).toEqual(["openai"]);
          expect(first.guardrail.apiKeys).toEqual([first.a.hash]);

          const live = (yield* SDK.getGuardrail({ id: first.guardrail.id })).data;
          expect(live.allowed_providers).toEqual(["openai"]);
          expect(live.limit_usd).toBe(1);
          expect(live.reset_interval).toBe("daily");
          expect(yield* assignedKeys(first.guardrail.id)).toEqual([first.a.hash]);

          // Widen the policy, change the budget and move the assignment to B.
          const second = yield* deployPolicy(
            {
              description: "alchemy guardrail test (updated)",
              allowedProviders: ["anthropic", "openai"],
              limitUsd: 2,
              resetInterval: "weekly",
              enforceZdr: true,
            },
            ["b"],
          );
          expect(second.guardrail.id).toBe(first.guardrail.id);
          const liveUpdated = (yield* SDK.getGuardrail({ id: first.guardrail.id })).data;
          expect([...(liveUpdated.allowed_providers ?? [])].sort()).toEqual([
            "anthropic",
            "openai",
          ]);
          expect(liveUpdated.limit_usd).toBe(2);
          expect(liveUpdated.reset_interval).toBe("weekly");
          expect(liveUpdated.enforce_zdr_openai).toBe(true);
          expect(liveUpdated.description).toBe("alchemy guardrail test (updated)");
          expect(yield* assignedKeys(first.guardrail.id)).toEqual([second.b.hash]);

          // Clearing the budget and provider restriction, and unassigning all keys.
          yield* deployPolicy({}, []);
          const liveCleared = (yield* SDK.getGuardrail({ id: first.guardrail.id })).data;
          expect(liveCleared.limit_usd ?? null).toBeNull();
          expect(liveCleared.allowed_providers ?? null).toBeNull();
          expect(yield* assignedKeys(first.guardrail.id)).toEqual([]);

          yield* stack.destroy();
          yield* waitForGuardrailDeleted(first.guardrail.id);
        }).pipe(logLevel),
      { timeout: 120_000 },
    );
  },
);
