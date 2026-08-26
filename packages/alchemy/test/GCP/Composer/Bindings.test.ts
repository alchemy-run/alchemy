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
  hasGcpCreds && !!process.env.GCP_TEST_COMPOSER && !process.env.FAST;

test.provider.skipIf(!runLifecycle)(
  "GetEnvironment and ExecuteAirflowCommand invoke HTTP bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const environment = yield* GCP.Composer.Environment("Airflow", {
            location: "us-central1",
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* environment.name;
              const getEnvironment =
                yield* GCP.Composer.GetEnvironment(environment);
              const execute =
                yield* GCP.Composer.ExecuteAirflowCommand(environment);
              return Effect.fn(function* () {
                const live = yield* getEnvironment();
                const command = yield* execute({
                  body: { command: "version" },
                });
                return { live, command };
              });
            }),
          );
          return { environment, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.live.name).toEqual(out.environment.name);
      expect(out.probe.command).toBeDefined();

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!runLifecycle)(
  "GetUserWorkloadsConfigMap and GetUserWorkloadsSecret invoke HTTP bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const environment = yield* GCP.Composer.Environment("Airflow", {
            location: "us-central1",
            config: {
              environmentSize: "ENVIRONMENT_SIZE_SMALL",
              softwareConfig: { imageVersion: "composer-3-airflow-2" },
            },
          });
          const config = yield* GCP.Composer.EnvironmentsUserWorkloadsConfigMap(
            "TaskConfig",
            {
              environmentName: environment.name,
              data: { LOG_LEVEL: "INFO" },
            },
          );
          const secret = yield* GCP.Composer.EnvironmentsUserWorkloadsSecret(
            "TaskSecret",
            {
              environmentName: environment.name,
              data: { password: btoa("s3cret") },
            },
          );
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* config.name;
              yield* secret.name;
              const getConfigMap =
                yield* GCP.Composer.GetUserWorkloadsConfigMap(config);
              const getSecret =
                yield* GCP.Composer.GetUserWorkloadsSecret(secret);
              return Effect.fn(function* () {
                const liveConfig = yield* getConfigMap();
                const liveSecret = yield* getSecret();
                return { liveConfig, liveSecret };
              });
            }),
          );
          return {
            config,
            secret,
            probe: yield* Probe({}),
          };
        }),
      );

      expect(out.probe.liveConfig.name).toEqual(out.config.name);
      expect(out.probe.liveSecret.name).toEqual(out.secret.name);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
