import { wrapWorkflowStep } from "@/Cloudflare/Workflows/WorkflowBridge.ts";
import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

describe("WorkflowBridge", () => {
  it.effect("preserves native Workflow control-flow rejections", () =>
    Effect.gen(function* () {
      const controlError = new Error("Aborting engine: User called pause");
      const rejectWithControlError = () =>
        Effect.runPromise(Effect.die(controlError));
      const step = wrapWorkflowStep({
        do: rejectWithControlError,
        sleep: rejectWithControlError,
        sleepUntil: rejectWithControlError,
        waitForEvent: rejectWithControlError,
      });

      const effects = [
        step.do({ name: "task", effect: Effect.succeed("done") }),
        step.sleep("sleep", "1 second"),
        step.sleepUntil("sleep-until", 1),
        step.waitForEvent("event", { type: "test-event" }),
      ];

      for (const effect of effects) {
        const exit = yield* Effect.exit(effect);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBe(controlError);
        }
      }
    }),
  );

  it.effect("only sends step-config keys that have a value", () =>
    Effect.gen(function* () {
      // The Workflows engine merges a step config over its own defaults by
      // spread, and an own property whose value is `undefined` still wins a
      // spread. So a config carrying `timeout: undefined` erased the engine's
      // `timeout: "10 minutes"`, which it then parsed with itty-time's
      // `e.match(/…/)` and died on — from the step's timeout race rather than
      // from the body, so the body succeeded on every attempt and the instance
      // errored afterwards naming nothing the user wrote.
      //
      // Assert on key PRESENCE, not on value: `toEqual({ retries })` passes for
      // `{ retries, timeout: undefined }`, which is precisely the bug.
      const seen: Array<Record<string, unknown> | undefined> = [];
      const step = wrapWorkflowStep({
        do: (_name: string, second: unknown) => {
          // `step.do` is overloaded — the config is only present when the
          // second argument is not the callback.
          seen.push(
            typeof second === "function"
              ? undefined
              : (second as Record<string, unknown>),
          );
          return Promise.resolve("done");
        },
      });

      const retries = { limit: 2, delay: "1 second" };
      const effect = Effect.succeed("done");
      yield* step.do({ name: "retries-only", effect, retries });
      yield* step.do({ name: "timeout-only", effect, timeout: "30 seconds" });
      yield* step.do({ name: "both", effect, retries, timeout: "30 seconds" });
      yield* step.do({ name: "neither", effect });

      const [retriesOnly, timeoutOnly, both, neither] = seen;

      expect("retries" in retriesOnly!).toBe(true);
      expect("timeout" in retriesOnly!).toBe(false);

      expect("timeout" in timeoutOnly!).toBe(true);
      expect("retries" in timeoutOnly!).toBe(false);

      expect("retries" in both!).toBe(true);
      expect("timeout" in both!).toBe(true);

      // Neither configured: no config argument at all, so the engine keeps
      // every default it has.
      expect(neither).toBeUndefined();
    }),
  );

  it.effect("scrubs rollbackConfig the same way", () =>
    Effect.gen(function* () {
      // A rollback does not get a config path of its own: `executeRollbacks`
      // feeds `rollbackConfig` straight back through
      // `ctx.do(target, config ?? {}, …)`, so it lands on the same
      // defaults-merge and the same duration parse as any other step. Unlike
      // the step's own config this one arrives from the caller, so it only
      // detonates for someone building it programmatically — and it does so
      // while rolling back an already-failing instance, which is worse to read.
      let rollback: { rollbackConfig?: Record<string, unknown> } | undefined;
      const step = wrapWorkflowStep({
        do: (
          _name: string,
          _config: unknown,
          _callback: unknown,
          fourth: unknown,
        ) => {
          rollback = fourth as { rollbackConfig?: Record<string, unknown> };
          return Promise.resolve("done");
        },
      });

      yield* step.do({
        name: "with-rollback",
        effect: Effect.succeed("done"),
        retries: { limit: 2, delay: "1 second" },
        rollback: () => Effect.void,
        // `timeout: undefined` type-checks against `timeout?: string | number`,
        // so `{ retries, timeout: someConfig.timeout }` compiles and used to
        // reach the engine intact.
        rollbackConfig: {
          retries: { limit: 1, delay: "1 second" },
          timeout: undefined,
        },
      });

      expect("retries" in rollback!.rollbackConfig!).toBe(true);
      expect("timeout" in rollback!.rollbackConfig!).toBe(false);
    }),
  );
});
