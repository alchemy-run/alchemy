import { Action } from "@/Action";
import * as GCP from "@/GCP";
import type { StackServices } from "@/Stack";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({
  providers: GCP.providers() as Layer.Layer<
    GCP.ProviderRequirements,
    never,
    StackServices
  >,
});

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
  hasGcpCreds && !!process.env.GCP_TEST_SQL && !process.env.FAST;

test.provider.skipIf(!runLifecycle)(
  "GetInstance, GetUser, and ExecuteSql invoke HTTP bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.SQL.Instance("AppDb", {
            region: "us-central1",
            databaseVersion: "MYSQL_8_0",
            tier: "db-f1-micro",
            backupEnabled: false,
            deletionProtectionEnabled: false,
            dataApiAccess: true,
          });
          const user = yield* GCP.SQL.User("AppUser", {
            instance: instance.instanceName,
            password: "Alchemy-test-1",
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* user.userName;
              const getInstance = yield* GCP.SQL.GetInstance(instance);
              const getUser = yield* GCP.SQL.GetUser(user);
              const executeSql = yield* GCP.SQL.ExecuteSql(instance);
              return Effect.fn(function* () {
                const live = yield* getInstance();
                const liveUser = yield* getUser();
                const result = yield* executeSql({
                  body: {
                    sqlStatement: "SELECT 1",
                    database: "mysql",
                    user: liveUser.name,
                  },
                });
                return { live, liveUser, result };
              });
            }),
          );
          return { instance, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.live.name).toEqual(out.instance.instanceName);
      expect(out.probe.liveUser.name).toEqual(expect.any(String));
      expect(out.probe.result).toBeDefined();

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
