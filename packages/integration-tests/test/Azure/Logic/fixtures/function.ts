import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";

// Workflows the fixture binds. Module-scope so the test stack yields the
// same declarations. Each binding gets its own workflow: the tests run
// concurrently and count runs.

/** Name of every fixture workflow's trigger. */
export const TRIGGER = "recurrence";

/**
 * A recurrence trigger that first fires in 2070 (Azure allows 49 years ahead), so the only runs are the
 * ones the tests start.
 */
const definition = (actions: Record<string, unknown>) => ({
  $schema:
    "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
  contentVersion: "1.0.0.0",
  triggers: {
    [TRIGGER]: {
      type: "Recurrence",
      recurrence: { frequency: "Month", interval: 1, startTime: "2070-01-01T00:00:00Z" },
    },
  },
  actions,
});

/** Started by `RunWorkflowTrigger`; its run finishes at once. */
export const Ticker = Azure.Logic.Workflow("LogicBindingsTicker", {
  definition: definition({ tick: { type: "Compose", inputs: "tick" } }),
});

/** Its runs wait 10 minutes, so `CancelWorkflowRun` finds one running. */
export const Sleeper = Azure.Logic.Workflow("LogicBindingsSleeper", {
  definition: definition({
    wait: { type: "Wait", inputs: { interval: { count: 10, unit: "Minute" } } },
  }),
});

/**
 * Reset by `ResetWorkflowTrigger`. Only stateful polling connector triggers
 * (which need an API connection to an external system) support reset; this
 * `Recurrence` trigger answers the typed `WorkflowTriggerResetNotSupported`,
 * which ARM returns only after the caller's role check passes.
 */
export const Resettable = Azure.Logic.Workflow("LogicBindingsResettable", {
  definition: definition({ tick: { type: "Compose", inputs: "tick" } }),
});

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result: result ?? null })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/**
 * Effect-native Azure Function exercising every Logic Apps runtime-action
 * binding on a managed-identity host, one route per binding. Routes answer
 * `{ ok, result | error }` with a 500 on error, so a caller retries through
 * the cold start and role propagation, and a real failure shows the ARM
 * error.
 */
export default class LogicFunction extends Azure.Functions.Function<LogicFunction>()(
  "LogicFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const ticker = yield* Ticker;
    const sleeper = yield* Sleeper;
    const resettable = yield* Resettable;

    const runTrigger = yield* Azure.Logic.RunWorkflowTrigger(ticker);
    const cancelRun = yield* Azure.Logic.CancelWorkflowRun(sleeper);
    const resetTrigger = yield* Azure.Logic.ResetWorkflowTrigger(resettable);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        switch (url.pathname) {
          case "/run-trigger":
            return yield* respond(Effect.as(runTrigger({ triggerName: TRIGGER }), "ran"));
          case "/cancel-run":
            return yield* respond(
              Effect.as(cancelRun({ runName: url.searchParams.get("run") ?? "" }), "cancelled"),
            );
          case "/reset-trigger":
            return yield* respond(
              resetTrigger({ triggerName: TRIGGER }).pipe(
                Effect.as({ reset: true } as { reset?: boolean; rejected?: string }),
                Effect.catchTag("WorkflowTriggerResetNotSupported", (e) =>
                  Effect.succeed({ rejected: e._tag }),
                ),
              ),
            );
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.Logic.RunWorkflowTriggerHttp,
        Azure.Logic.CancelWorkflowRunHttp,
        Azure.Logic.ResetWorkflowTriggerHttp,
      ),
    ),
  ),
) {}
