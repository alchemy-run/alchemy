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

const runLifecycle =
  hasGcpCreds && !!process.env.GCP_TEST_DATAPROC && !process.env.FAST;

test.provider.skipIf(!runLifecycle)(
  "GetCluster and SubmitJob invoke HTTP bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* GCP.Dataproc.Cluster("Jobs", {
            region: "us-central1",
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* cluster.name;
              const getCluster = yield* GCP.Dataproc.GetCluster(cluster);
              const submitJob = yield* GCP.Dataproc.SubmitJob(cluster);
              return Effect.fn(function* () {
                const live = yield* getCluster();
                const job = yield* submitJob({
                  body: {
                    job: {
                      placement: { clusterName: live.clusterName },
                      pigJob: { queryList: { queries: ["DUMP;"] } },
                    },
                  },
                });
                return { live, job };
              });
            }),
          );
          return { cluster, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.live.clusterName).toEqual(out.cluster.clusterName);
      expect(out.probe.job.placement?.clusterName).toEqual(
        out.cluster.clusterName,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
