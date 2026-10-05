import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { WorkerObservability } from "./Worker.ts";

/** Reconcile Issues after a full script upload, which can reset the flag. */
export const syncWorkerIssues = Effect.fn(
  function* (accountId: string, scriptName: string, observability: WorkerObservability) {
    const settings = yield* workers.getScriptSetting({ accountId, scriptName });
    const enabled = observability.issues?.enabled ?? false;
    if ((settings.observability?.issues?.enabled ?? false) !== enabled) {
      // The settings endpoint replaces observability, so carry logs and traces
      // (including Telemetry bindings) through with the desired Issues flag.
      yield* workers.patchScriptSetting({
        accountId,
        scriptName,
        observability: {
          ...observability,
          headSamplingRate: observability.headSamplingRate ?? undefined,
          logs: observability.logs
            ? {
                ...observability.logs,
                headSamplingRate: observability.logs.headSamplingRate ?? undefined,
              }
            : undefined,
          traces: observability.traces
            ? {
                ...observability.traces,
                headSamplingRate: observability.traces.headSamplingRate ?? undefined,
              }
            : undefined,
          issues: { enabled },
        },
      });
    }
  },
  Effect.retry({
    // A fresh upload can reach the settings endpoint before the script registry.
    while: (error) => error._tag === "WorkerNotFound" || error._tag === "WorkerHasNoVersions",
    schedule: Schedule.exponential("100 millis"),
    times: 6,
  }),
);
