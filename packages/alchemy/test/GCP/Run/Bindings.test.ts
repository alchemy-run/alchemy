import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const IMAGE = "us-docker.pkg.dev/cloudrun/container/hello";
const WORKER_IMAGE = "us-docker.pkg.dev/cloudrun/container/worker-pool";

test.provider.skipIf(!hasGcpCreds)(
  "GetService, GetWorkerPool, and RunJob invoke HTTP bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const service = yield* GCP.Run.Service("Api", {
            location: "us-central1",
            template: {
              containers: [{ image: IMAGE }],
            },
          });
          const workerPool = yield* GCP.Run.WorkerPool("Workers", {
            location: "us-central1",
            template: {
              containers: [{ image: WORKER_IMAGE }],
            },
          });
          const job = yield* GCP.Run.Job("Migrate", {
            location: "us-central1",
            containers: [{ image: IMAGE }],
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* job.name;
              const getService = yield* GCP.Run.GetService(service);
              const getWorkerPool = yield* GCP.Run.GetWorkerPool(workerPool);
              const runJob = yield* GCP.Run.RunJob(job);
              return Effect.fn(function* () {
                const liveService = yield* getService();
                const livePool = yield* getWorkerPool();
                const execution = yield* runJob();
                return { liveService, livePool, execution };
              });
            }),
          );
          return {
            service,
            workerPool,
            probe: yield* Probe({}),
          };
        }),
      );

      expect(out.probe.liveService.name).toEqual(out.service.name);
      expect(out.probe.livePool.name).toEqual(out.workerPool.name);
      expect(out.probe.execution.name).toEqual(expect.any(String));

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
