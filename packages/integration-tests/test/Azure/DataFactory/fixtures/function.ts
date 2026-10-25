import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";

// Resources the fixture binds. Module-scope so the test stack yields the
// same declarations.

export const Factory = Azure.DataFactory.Factory("DfBindingsFactory");

const pipeline = (id: string, waitTimeInSeconds: number) =>
  Effect.gen(function* () {
    const factory = yield* Factory;
    return yield* Azure.DataFactory.Pipeline(id, {
      factoryName: factory.factoryName,
      activities: [{ name: "pause", type: "Wait", typeProperties: { waitTimeInSeconds } }],
    });
  });

/** Run by `RunPipeline`: one short Wait activity. */
export const Quick = pipeline("DfBindingsQuick", 1);
/** Cancelled by `CancelPipelineRun` while it waits. */
export const Slow = pipeline("DfBindingsSlow", 600);

/** A daily trigger that starts in 2060, so a started trigger never fires. */
const trigger = (id: string, started: boolean) =>
  Effect.gen(function* () {
    const factory = yield* Factory;
    const quick = yield* Quick;
    return yield* Azure.DataFactory.Trigger(id, {
      factoryName: factory.factoryName,
      type: "ScheduleTrigger",
      typeProperties: {
        recurrence: {
          frequency: "Day",
          interval: 1,
          startTime: "2060-01-01T00:00:00Z",
          timeZone: "UTC",
        },
      },
      pipelines: [{ pipelineName: quick.pipelineName }],
      started,
    });
  });

/** Deployed stopped; `StartTrigger` starts it. */
export const Stopped = trigger("DfBindingsStopped", false);
/** Deployed started; `StopTrigger` stops it. */
export const Started = trigger("DfBindingsStarted", true);

/**
 * A self-hosted integration runtime with no node: free. Start and stop
 * apply only to managed (Azure-SSIS) runtimes, so the bindings answer the
 * runtime's typed rejection.
 */
export const Runtime = Effect.gen(function* () {
  const factory = yield* Factory;
  return yield* Azure.DataFactory.IntegrationRuntime("DfBindingsRuntime", {
    factoryName: factory.factoryName,
    type: "SelfHosted",
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
 * Answer the operation's error tag as a result, so a caller can assert
 * Azure's typed rejection. `AuthorizationFailed` stays an error: the role
 * is still propagating and the caller retries.
 */
const rejection = <E extends { readonly _tag: string }>(
  effect: Effect.Effect<unknown, E, RuntimeContext>,
) =>
  respond(
    effect.pipe(
      Effect.flatMap(() => Effect.succeed({ rejected: false })),
      Effect.catchIf(
        (e) => e._tag !== "AuthorizationFailed",
        (e) => Effect.succeed({ rejected: e._tag }),
      ),
    ),
  );

/**
 * Effect-native Azure Function exercising every Data Factory runtime-action
 * binding on a managed-identity host, one route per binding.
 */
export default class DataFactoryFunction extends Azure.Functions.Function<DataFactoryFunction>()(
  "DataFactoryFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const factory = yield* Factory;
    const quick = yield* Quick;
    const stopped = yield* Stopped;
    const started = yield* Started;
    const runtime = yield* Runtime;

    const runPipeline = yield* Azure.DataFactory.RunPipeline(quick);
    const getPipelineRun = yield* Azure.DataFactory.GetPipelineRun(factory);
    const cancelPipelineRun = yield* Azure.DataFactory.CancelPipelineRun(factory);
    const queryPipelineRuns = yield* Azure.DataFactory.QueryPipelineRuns(factory);
    const startTrigger = yield* Azure.DataFactory.StartTrigger(stopped);
    const stopTrigger = yield* Azure.DataFactory.StopTrigger(started);
    const cancelTriggerRun = yield* Azure.DataFactory.CancelTriggerRun(started);
    const rerunTriggerRun = yield* Azure.DataFactory.RerunTriggerRun(started);
    const startIntegrationRuntime = yield* Azure.DataFactory.StartIntegrationRuntime(runtime);
    const stopIntegrationRuntime = yield* Azure.DataFactory.StopIntegrationRuntime(runtime);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const runId = url.searchParams.get("run") ?? "";
        switch (url.pathname) {
          case "/run-pipeline":
            return yield* respond(runPipeline({ body: {} }));
          case "/get-pipeline-run":
            return yield* respond(
              Effect.map(getPipelineRun({ runId }), (run) => ({
                runId: run.runId,
                pipelineName: run.pipelineName,
              })),
            );
          case "/cancel-pipeline-run":
            return yield* respond(Effect.as(cancelPipelineRun({ runId }), { runId }));
          case "/query-pipeline-runs":
            return yield* respond(
              Effect.map(
                queryPipelineRuns({
                  lastUpdatedAfter: new Date(Date.now() - 3_600_000).toISOString(),
                  lastUpdatedBefore: new Date(Date.now() + 3_600_000).toISOString(),
                  filters: [
                    {
                      operand: "PipelineName",
                      operator: "Equals",
                      values: [url.searchParams.get("pipeline") ?? ""],
                    },
                  ],
                }),
                (page) => page.value.map((run) => run.runId),
              ),
            );
          case "/start-trigger":
            return yield* respond(Effect.as(startTrigger(), { started: true }));
          case "/stop-trigger":
            return yield* respond(Effect.as(stopTrigger(), { stopped: true }));
          case "/cancel-trigger-run":
            return yield* rejection(cancelTriggerRun({ runId }));
          case "/rerun-trigger-run":
            return yield* rejection(rerunTriggerRun({ runId }));
          case "/start-integration-runtime":
            return yield* rejection(startIntegrationRuntime());
          case "/stop-integration-runtime":
            return yield* rejection(stopIntegrationRuntime());
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.DataFactory.RunPipelineHttp,
        Azure.DataFactory.GetPipelineRunHttp,
        Azure.DataFactory.CancelPipelineRunHttp,
        Azure.DataFactory.QueryPipelineRunsHttp,
        Azure.DataFactory.StartTriggerHttp,
        Azure.DataFactory.StopTriggerHttp,
        Azure.DataFactory.CancelTriggerRunHttp,
        Azure.DataFactory.RerunTriggerRunHttp,
        Azure.DataFactory.StartIntegrationRuntimeHttp,
        Azure.DataFactory.StopIntegrationRuntimeHttp,
      ),
    ),
  ),
) {}
