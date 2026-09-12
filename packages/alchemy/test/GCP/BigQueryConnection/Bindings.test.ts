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

test.provider.skipIf(!hasGcpCreds)(
  "GetConnection invokes the HTTP binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const connection = yield* GCP.BigQueryConnection.Connection("Cloud", {
            location: "us-central1",
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* connection.name;
              const getConnection =
                yield* GCP.BigQueryConnection.GetConnection(connection);
              return Effect.fn(function* () {
                return yield* getConnection();
              });
            }),
          );
          return { connection, live: yield* Probe({}) };
        }),
      );

      expect(out.live.name).toEqual(out.connection.name);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
