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
  hasGcpCreds && !!process.env.GCP_TEST_REDIS && !process.env.FAST;

test.provider.skipIf(!runLifecycle)(
  "GetInstance and GetAuthString invoke HTTP bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const cache = yield* GCP.Redis.Instance("Cache", {
            location: "us-central1",
            tier: "BASIC",
            memorySizeGb: 1,
            authEnabled: true,
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* cache.name;
              const getInstance = yield* GCP.Redis.GetInstance(cache);
              const getAuthString = yield* GCP.Redis.GetAuthString(cache);
              return Effect.fn(function* () {
                const live = yield* getInstance();
                const auth = yield* getAuthString();
                return { live, auth };
              });
            }),
          );
          return { cache, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.live.name).toEqual(out.cache.name);
      expect(out.probe.auth.authString).toEqual(expect.any(String));

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
