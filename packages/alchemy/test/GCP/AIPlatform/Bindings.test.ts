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
  hasGcpCreds &&
  !process.env.FAST &&
  !!(process.env.GCP_TEST_AIPLATFORM || process.env.GCP_TEST_VERTEX);

test.provider.skipIf(!runLifecycle)(
  "GetReasoningEngine invokes the HTTP binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const engine = yield* GCP.AIPlatform.ReasoningEngine("Agent", {
            location: "us-central1",
            displayName: "alchemy-binding-engine",
            spec: { agentFramework: "custom" },
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* engine.name;
              const getEngine =
                yield* GCP.AIPlatform.GetReasoningEngine(engine);
              return Effect.fn(function* () {
                const live = yield* getEngine();
                return { live };
              });
            }),
          );
          return { engine, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.live.name).toEqual(out.engine.name);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
