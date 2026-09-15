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
  "GetKeyString returns the key material",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { keyString } = yield* stack.deploy(
        Effect.gen(function* () {
          const key = yield* GCP.ApiKeys.Key("Maps", {});
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* key.name;
              const getKeyString = yield* GCP.ApiKeys.GetKeyString(key);
              return Effect.fn(function* () {
                return yield* getKeyString();
              });
            }),
          );
          return yield* Probe({});
        }),
      );

      expect(keyString).toEqual(expect.any(String));
      expect((keyString ?? "").length).toBeGreaterThan(8);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
