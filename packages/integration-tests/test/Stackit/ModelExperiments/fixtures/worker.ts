import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const Experiments = Stackit.ModelExperiments.Instance(
  "ModelExperimentsBindingsInstance",
  {},
);

export const Tracking = Experiments.pipe(
  Effect.flatMap((instance) =>
    Stackit.ModelExperiments.Token("ModelExperimentsBindingsToken", {
      instanceId: instance.instanceId,
    }),
  ),
);

/**
 * A Cloudflare Worker with every AI Model Experiments binding. One route per binding; each answers
 * `{ ok, result | error }` so a failure surfaces the error in the test. The token's value never
 * leaves the Worker.
 */
export default class ModelExperimentsBindingsWorker extends Cloudflare.Worker<ModelExperimentsBindingsWorker>()(
  "StackitModelExperimentsBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const instance = yield* Experiments;
    const tracking = yield* Tracking;
    const getInstance = yield* Stackit.ModelExperiments.GetInstance(instance);
    const listInstances = yield* Stackit.ModelExperiments.ListInstances(instance);
    const getToken = yield* Stackit.ModelExperiments.GetToken(tracking);
    const listTokens = yield* Stackit.ModelExperiments.ListTokens(instance);
    const createExperiment = yield* Stackit.ModelExperiments.CreateExperiment(tracking);
    const getExperiment = yield* Stackit.ModelExperiments.GetExperiment(tracking);
    const getExperimentByName = yield* Stackit.ModelExperiments.GetExperimentByName(tracking);
    const createRun = yield* Stackit.ModelExperiments.CreateRun(tracking);
    const updateRun = yield* Stackit.ModelExperiments.UpdateRun(tracking);
    const getRun = yield* Stackit.ModelExperiments.GetRun(tracking);
    const searchRuns = yield* Stackit.ModelExperiments.SearchRuns(tracking);
    const logMetric = yield* Stackit.ModelExperiments.LogMetric(tracking);
    const logParam = yield* Stackit.ModelExperiments.LogParam(tracking);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const param = (name: string) => url.searchParams.get(name) ?? "";
        const experimentId = param("experimentId");
        const runId = param("runId");
        const name = param("name");
        const now = yield* Clock.currentTimeMillis;
        switch (url.pathname) {
          case "/get-instance":
            return yield* respond(getInstance());
          case "/list-instances":
            return yield* respond(listInstances());
          case "/get-token":
            return yield* respond(getToken());
          case "/list-tokens":
            return yield* respond(listTokens());
          case "/create-experiment":
            return yield* respond(createExperiment({ name }));
          case "/create-experiment-taken":
            // The typed error, as a value: it is the behaviour under test.
            return yield* respond(
              createExperiment({ name }).pipe(
                Effect.map(() => ({ taken: false })),
                Effect.catchTag("ExperimentAlreadyExists", () => Effect.succeed({ taken: true })),
              ),
            );
          case "/get-experiment":
            return yield* respond(getExperiment({ experiment_id: experimentId }));
          case "/get-experiment-by-name":
            return yield* respond(getExperimentByName({ experiment_name: name }));
          case "/create-run":
            return yield* respond(
              createRun({
                experiment_id: experimentId,
                run_name: name,
                start_time: now,
                tags: [{ key: "suite", value: "bindings" }],
              }),
            );
          case "/get-run":
            return yield* respond(getRun({ run_id: runId }));
          case "/get-run-missing":
            // The typed error, as a value: it is the behaviour under test.
            return yield* respond(
              getRun({ run_id: "00000000000000000000000000000000" }).pipe(
                Effect.map(() => ({ missing: false })),
                Effect.catchTag("NotFound", () => Effect.succeed({ missing: true })),
              ),
            );
          case "/update-run":
            return yield* respond(
              updateRun({
                run_id: runId,
                status: "FINISHED",
                end_time: now,
              }),
            );
          case "/search-runs":
            return yield* respond(
              searchRuns({
                experiment_ids: [experimentId],
                filter: "metrics.loss < 1",
                max_results: 10,
              }),
            );
          case "/log-metric":
            return yield* respond(
              logMetric({
                run_id: runId,
                key: "loss",
                value: 0.5,
                timestamp: now,
                step: 1,
              }),
            );
          case "/log-param":
            return yield* respond(logParam({ run_id: runId, key: "lr", value: "0.1" }));
          case "/log-param-changed":
            // The typed error, as a value: it is the behaviour under test.
            return yield* respond(
              logParam({ run_id: runId, key: "lr", value: "0.2" }).pipe(
                Effect.map(() => ({ conflict: false })),
                Effect.catchTag("ParamValueConflict", () => Effect.succeed({ conflict: true })),
              ),
            );
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(Stackit.ModelExperiments.GetInstanceHttp),
    Effect.provide(Stackit.ModelExperiments.ListInstancesHttp),
    Effect.provide(Stackit.ModelExperiments.GetTokenHttp),
    Effect.provide(Stackit.ModelExperiments.ListTokensHttp),
    Effect.provide(Stackit.ModelExperiments.CreateExperimentHttp),
    Effect.provide(Stackit.ModelExperiments.GetExperimentHttp),
    Effect.provide(Stackit.ModelExperiments.GetExperimentByNameHttp),
    Effect.provide(Stackit.ModelExperiments.CreateRunHttp),
    Effect.provide(Stackit.ModelExperiments.UpdateRunHttp),
    Effect.provide(Stackit.ModelExperiments.GetRunHttp),
    Effect.provide(Stackit.ModelExperiments.SearchRunsHttp),
    Effect.provide(Stackit.ModelExperiments.LogMetricHttp),
    Effect.provide(Stackit.ModelExperiments.LogParamHttp),
  ),
) {}
