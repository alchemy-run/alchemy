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
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_WORKSTATIONS;

test.provider.skipIf(!runLifecycle)(
  "GetWorkstationCluster, GetWorkstationConfig, and GetWorkstation invoke HTTP bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* GCP.Workstations.WorkstationCluster("Dev", {
            location: "us-central1",
            network: "default",
            subnetwork: "default",
            labels: { env: "test" },
          });
          const config =
            yield* GCP.Workstations.WorkstationClustersWorkstationConfig(
              "Code",
              {
                workstationCluster: cluster.name,
                host: {
                  gceInstance: {
                    machineType: "e2-standard-2",
                    poolSize: 0,
                    bootDiskSizeGb: 30,
                  },
                },
                labels: { env: "test" },
              },
            );
          const workstation =
            yield* GCP.Workstations.WorkstationClustersWorkstationConfigsWorkstation(
              "Mine",
              { workstationConfig: config.name, labels: { env: "test" } },
            );
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* cluster.name;
              yield* config.name;
              yield* workstation.name;
              const getCluster =
                yield* GCP.Workstations.GetWorkstationCluster(cluster);
              const getConfig =
                yield* GCP.Workstations.GetWorkstationConfig(config);
              const getWorkstation =
                yield* GCP.Workstations.GetWorkstation(workstation);
              const generateToken =
                yield* GCP.Workstations.GenerateAccessToken(workstation);
              const start =
                yield* GCP.Workstations.StartWorkstation(workstation);
              const stop = yield* GCP.Workstations.StopWorkstation(workstation);
              return Effect.fn(function* () {
                const liveCluster = yield* getCluster();
                const liveConfig = yield* getConfig();
                const liveWorkstation = yield* getWorkstation();
                const token = yield* generateToken({
                  body: { ttl: "3600s" },
                }).pipe(
                  Effect.map((result) => ({ tag: "ok" as const, result })),
                  Effect.catchTag(
                    ["Forbidden", "BadRequest", "NotFound", "Conflict"],
                    (error) =>
                      Effect.succeed({
                        tag: error._tag,
                        message: error.message,
                      }),
                  ),
                );
                const started = yield* start().pipe(
                  Effect.map((result) => ({ tag: "ok" as const, result })),
                  Effect.catchTag(
                    ["Forbidden", "BadRequest", "NotFound", "Conflict"],
                    (error) =>
                      Effect.succeed({
                        tag: error._tag,
                        message: error.message,
                      }),
                  ),
                );
                const stopped = yield* stop().pipe(
                  Effect.map((result) => ({ tag: "ok" as const, result })),
                  Effect.catchTag(
                    ["Forbidden", "BadRequest", "NotFound", "Conflict"],
                    (error) =>
                      Effect.succeed({
                        tag: error._tag,
                        message: error.message,
                      }),
                  ),
                );
                return {
                  liveCluster,
                  liveConfig,
                  liveWorkstation,
                  token,
                  started,
                  stopped,
                };
              });
            }),
          );
          return {
            cluster,
            config,
            workstation,
            probe: yield* Probe({}),
          };
        }),
      );

      expect(out.probe.liveCluster.name).toEqual(out.cluster.name);
      expect(out.probe.liveConfig.name).toEqual(out.config.name);
      expect(out.probe.liveWorkstation.name).toEqual(out.workstation.name);
      expect([
        "ok",
        "Forbidden",
        "BadRequest",
        "NotFound",
        "Conflict",
      ]).toContain(out.probe.token.tag);
      expect([
        "ok",
        "Forbidden",
        "BadRequest",
        "NotFound",
        "Conflict",
      ]).toContain(out.probe.started.tag);
      expect([
        "ok",
        "Forbidden",
        "BadRequest",
        "NotFound",
        "Conflict",
      ]).toContain(out.probe.stopped.tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
