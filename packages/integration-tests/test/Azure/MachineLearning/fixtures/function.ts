import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";
import { baseDefault } from "../util.ts";

// Resources the fixture binds. Module-scope so the test stack yields the
// same declarations.

/** A compute instance (start/stop/restart apply only to compute instances). */
export const Instance = Effect.gen(function* () {
  const base = yield* baseDefault();
  return yield* Azure.MachineLearning.Compute("MlBindingsInstance", {
    resourceGroup: base.group.resourceGroupName,
    workspace: base.workspace.workspaceName,
    computeType: "ComputeInstance",
    vmSize: "Standard_D2s_v3",
  });
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
 * Effect-native Azure Function exercising every Machine Learning
 * runtime-action binding on a managed-identity host, one route per binding.
 * Routes answer `{ ok, result | error }` with a 500 on error, so a caller
 * retries through the cold start and role propagation, and a real failure
 * shows the ARM error.
 */
export default class MachineLearningFunction extends Azure.Functions.Function<MachineLearningFunction>()(
  "MachineLearningFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const instance = yield* Instance;

    const startCompute = yield* Azure.MachineLearning.StartCompute(instance);
    const stopCompute = yield* Azure.MachineLearning.StopCompute(instance);
    const restartCompute = yield* Azure.MachineLearning.RestartCompute(instance);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        switch (url.pathname) {
          case "/start":
            return yield* respond(Effect.as(startCompute(), "started"));
          case "/stop":
            return yield* respond(Effect.as(stopCompute(), "stopped"));
          case "/restart":
            return yield* respond(Effect.as(restartCompute(), "restarted"));
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.MachineLearning.StartComputeHttp,
        Azure.MachineLearning.StopComputeHttp,
        Azure.MachineLearning.RestartComputeHttp,
      ),
    ),
  ),
) {}
