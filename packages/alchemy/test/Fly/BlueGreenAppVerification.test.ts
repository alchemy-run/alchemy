import * as Fly from "@/Fly";
import { DestroyError } from "@/Apply";
import { AppDeletionAmbiguous } from "@/Fly/App";
import * as Test from "@/Test/Alchemy";
import { assert, expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { engineActor } from "./fixtures/actors.ts";
import { assertAppGone } from "./fixtures/bluegreen.ts";
import { transportProxy } from "./fixtures/transport.ts";

const { test } = Test.make({ providers: Fly.providers() });

for (const fault of [
  { action: "cut-request", stage: "cut", error: "HttpClientError" },
  { action: "hold-response", stage: "held", error: "TimeoutError" },
] as const) {
  const title = `F11 accepted App deletion reports bounded ambiguity for ${fault.action} verification GET`;

  test.provider(
    title,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const app = yield* stack.deploy(Fly.App("Site"));
        const proxy = yield* transportProxy();
        const actor = yield* engineActor(
          stack,
          title,
          "test/Fly/BlueGreenAppVerification.test.ts",
          proxy.url,
        );
        const path = `/v1/apps/${app.appName}`;
        yield* Effect.gen(function* () {
          yield* Effect.sync(() =>
            proxy.arm({
              match: (event) =>
                event.method === "GET" &&
                event.path === path &&
                proxy.events.some(
                  (accepted) =>
                    accepted.stage === "forwarded" &&
                    accepted.method === "DELETE" &&
                    accepted.path === path &&
                    accepted.status! >= 200 &&
                    accepted.status! < 300,
                ),
              action: fault.action,
              remaining: Infinity,
            }),
          );
          const deletion = yield* actor
            .destroy()
            .pipe(Effect.result, Effect.forkScoped);
          const accepted = yield* proxy.wait(
            (event) =>
              event.stage === "forwarded" &&
              event.method === "DELETE" &&
              event.path === path &&
              event.status! >= 200 &&
              event.status! < 300,
          );
          const verification = yield* proxy.wait(
            (event) =>
              event.stage === fault.stage &&
              event.method === "GET" &&
              event.path === path,
          );
          expect(verification.sequence).toBeGreaterThan(accepted.sequence);
          const result = yield* Fiber.join(deletion).pipe(
            Effect.timeout("45 seconds"),
          );
          assert(Result.isFailure(result));
          assert(result.failure instanceof DestroyError);
          expect(result.failure.blocked).toEqual([]);
          expect(result.failure.failures).toHaveLength(1);
          const failure = result.failure.failures[0]!;
          expect(failure.logicalId).toBe("Site");
          expect(failure.resourceType).toBe("Fly.App");
          const cause = Cause.findError(failure.cause);
          assert(Result.isSuccess(cause));
          assert(cause.success instanceof AppDeletionAmbiguous);
          expect(cause.success).toMatchObject({
            _tag: "Fly.AppDeletionAmbiguous",
            appName: app.appName,
            evidence: `delete accepted but absence verification failed: ${fault.error}`,
          });
          expect(cause.success.message).toContain(
            "reconcile the App before retrying or recreating its name",
          );
          expect(
            proxy.events.filter(
              (event) =>
                event.stage === "request" &&
                event.method === "DELETE" &&
                event.path === path,
            ),
          ).toHaveLength(1);
        }).pipe(
          Effect.scoped,
          Effect.ensuring(
            Effect.sync(() => {
              proxy.clear();
              proxy.dropHeld();
            }),
          ),
        );
        yield* assertAppGone(app.appName);
        // Explicit cleanup follows out-of-band absence, not a blind DELETE retry.
        yield* stack.destroy();
        yield* assertAppGone(app.appName);
      }).pipe(Effect.scoped),
    { timeout: 300_000 },
  );
}
