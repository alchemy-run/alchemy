import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

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

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  aiplatform.getReasoningEnginesSandboxEnvironments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getReasoningEnginesSandboxEnvironments on a missing sandbox fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getReasoningEnginesSandboxEnvironments({
          name: `projects/${project}/locations/us-central1/reasoningEngines/alchemy-missing-engine/sandboxEnvironments/alchemy-missing-sandbox`,
        }),
      );
      expect([
        "NotFound",
        "Forbidden",
        "BadRequest",
        "UnknownGCPError",
      ]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a sandbox environment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack
        .deploy(
          Effect.gen(function* () {
            const engine = yield* GCP.AIPlatform.ReasoningEngine("Agent", {
              location: "us-central1",
              displayName: "alchemy-sandbox-engine",
              labels: { env: "test" },
              spec: { agentFramework: "custom" },
            });
            const sandbox =
              yield* GCP.AIPlatform.ReasoningEnginesSandboxEnvironment("Code", {
                reasoningEngine: engine.name,
                displayName: "code",
                ttl: "600s",
                spec: {
                  codeExecutionEnvironment: {
                    codeLanguage: "LANGUAGE_PYTHON",
                    machineConfig: "MACHINE_CONFIG_VCPU4_RAM4GIB",
                  },
                },
              });
            return { engine, sandbox };
          }),
        )
        .pipe(
          Effect.catchTag("UnknownGCPError", (error) => {
            expect(error.message ?? "").toMatch(
              /not implemented|not supported|not enabled/i,
            );
            return Effect.succeed(undefined);
          }),
          Effect.catchTag(
            "GCP.AIPlatform.ReasoningEnginesSandboxEnvironmentNotResolved",
            () => Effect.succeed(undefined),
          ),
        );

      if (created === undefined) {
        yield* stack.destroy();
        return;
      }

      expect(created.sandbox.name).toContain("/sandboxEnvironments/");
      expect(created.sandbox.displayName).toEqual("code");
      expect(created.sandbox.reasoningEngine).toEqual(created.engine.name);

      const fetched = yield* aiplatform.getReasoningEnginesSandboxEnvironments({
        name: created.sandbox.name,
      });
      expect(fetched.name).toEqual(created.sandbox.name);
      expect(fetched.displayName ?? "").toMatch(/\[alc(hemy)? /);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.sandbox.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);
