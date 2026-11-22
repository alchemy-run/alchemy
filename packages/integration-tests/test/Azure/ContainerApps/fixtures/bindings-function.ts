import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";
import { CONSUMPTION_PROFILES, QUICKSTART_IMAGE, STANDARD_LOCATION } from "./shared.ts";

// Resources the fixture binds. Module-scope so the test stack yields the
// same declarations.

/** Public busybox image with `sleep`. */
const SLEEP_IMAGE = "mcr.microsoft.com/cbl-mariner/busybox:2.0";

const Environment = Azure.ContainerApps.ManagedEnvironment("ContainerAppsBindingsEnv", {
  location: STANDARD_LOCATION,
  workloadProfiles: CONSUMPTION_PROFILES,
});

/** App the bindings stop, start, and restart a revision of (one replica, no ingress). */
export const App = Effect.gen(function* () {
  const env = yield* Environment;
  return yield* Azure.ContainerApps.ContainerApp("ContainerAppsBindingsApp", {
    location: STANDARD_LOCATION,
    environmentId: env.environmentId,
    template: {
      containers: [
        {
          name: "api",
          image: QUICKSTART_IMAGE,
          resources: { cpu: 0.25, memory: "0.5Gi" },
        },
      ],
      scale: { minReplicas: 1, maxReplicas: 1 },
    },
  });
});

/** Manual job the bindings start, stop, suspend, and resume. */
export const Job = Effect.gen(function* () {
  const env = yield* Environment;
  return yield* Azure.ContainerApps.Job("ContainerAppsBindingsJob", {
    location: STANDARD_LOCATION,
    environmentId: env.environmentId,
    configuration: {
      triggerType: "Manual",
      replicaTimeout: 300,
      replicaRetryLimit: 0,
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 },
    },
    template: {
      containers: [
        {
          name: "main",
          // Runs long enough for `StopJobExecution` to stop it.
          image: SLEEP_IMAGE,
          command: ["sleep", "240"],
          resources: { cpu: 0.25, memory: "0.5Gi" },
        },
      ],
    },
  });
});

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/**
 * Effect-native Azure Function exercising every Container Apps
 * runtime-action binding on a managed-identity host, one route per binding.
 */
export default class ContainerAppsBindingsFunction extends Azure.Functions.Function<ContainerAppsBindingsFunction>()(
  "ContainerAppsBindingsFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const app = yield* App;
    const job = yield* Job;
    const startApp = yield* Azure.ContainerApps.StartContainerApp(app);
    const stopApp = yield* Azure.ContainerApps.StopContainerApp(app);
    const restartRevision = yield* Azure.ContainerApps.RestartContainerAppRevision(app);
    const startJob = yield* Azure.ContainerApps.StartJob(job);
    const stopExecution = yield* Azure.ContainerApps.StopJobExecution(job);
    const suspend = yield* Azure.ContainerApps.SuspendJob(job);
    const resume = yield* Azure.ContainerApps.ResumeJob(job);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const name = url.searchParams.get("name") ?? "";
        switch (url.pathname) {
          case "/app/start":
            return yield* respond(startApp());
          case "/app/stop":
            return yield* respond(stopApp());
          case "/app/restart-revision":
            return yield* respond(restartRevision({ revisionName: name }));
          case "/job/start":
            return yield* respond(
              Effect.map(startJob(), (execution) => ({ name: execution.name })),
            );
          case "/job/stop-execution":
            return yield* respond(stopExecution({ jobExecutionName: name }));
          case "/job/suspend":
            return yield* respond(suspend());
          case "/job/resume":
            return yield* respond(resume());
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.ContainerApps.StartContainerAppHttp,
        Azure.ContainerApps.StopContainerAppHttp,
        Azure.ContainerApps.RestartContainerAppRevisionHttp,
        Azure.ContainerApps.StartJobHttp,
        Azure.ContainerApps.StopJobExecutionHttp,
        Azure.ContainerApps.SuspendJobHttp,
        Azure.ContainerApps.ResumeJobHttp,
      ),
    ),
  ),
) {}
