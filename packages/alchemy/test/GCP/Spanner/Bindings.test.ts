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
  hasGcpCreds && !!process.env.GCP_TEST_SPANNER && !process.env.FAST;

test.provider.skipIf(!runLifecycle)(
  "GetInstance, GetDdl, and ExecuteSql invoke HTTP bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Spanner.Instance("Db", {
            config: "regional-us-central1",
            nodeCount: 1,
          });
          const database = yield* GCP.Spanner.Database("App", {
            instance: instance.name,
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* database.name;
              const getInstance = yield* GCP.Spanner.GetInstance(instance);
              const getDdl = yield* GCP.Spanner.GetDdl(database);
              const executeSql = yield* GCP.Spanner.ExecuteSql(database);
              return Effect.fn(function* () {
                const live = yield* getInstance();
                const ddl = yield* getDdl();
                const rows = yield* executeSql({
                  sql: "SELECT 1",
                });
                return { live, ddl, rows };
              });
            }),
          );
          return { instance, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.live.name).toEqual(out.instance.name);
      expect(out.probe.ddl).toBeDefined();
      expect(out.probe.rows).toBeDefined();

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
