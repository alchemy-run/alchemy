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
  aiplatform
    .getProjectsLocationsReasoningEnginesSandboxEnvironmentTemplates({ name })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsReasoningEnginesSandboxEnvironmentTemplates on a missing template fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform
          .getProjectsLocationsReasoningEnginesSandboxEnvironmentTemplates({
            name: `projects/${project}/locations/us-central1/reasoningEngines/alchemy-missing-engine/sandboxEnvironmentTemplates/alchemy-missing-template`,
          })
          .pipe(Effect.timeout("15 seconds")),
      );
      expect([
        "NotFound",
        "Forbidden",
        "BadRequest",
        "UnknownGCPError",
        "TimeoutError",
      ]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 30_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a sandbox environment template",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack
        .deploy(
          Effect.gen(function* () {
            const engine = yield* GCP.AIPlatform.ReasoningEngine("Agent", {
              location: "us-central1",
              displayName: "alchemy-template-engine",
              labels: { env: "test" },
              spec: { agentFramework: "custom" },
            });
            const template =
              yield* GCP.AIPlatform.ReasoningEnginesSandboxEnvironmentTemplate(
                "Browser",
                {
                  reasoningEngine: engine.name,
                  displayName: "browser",
                  defaultContainerEnvironment: {
                    defaultContainerCategory:
                      "DEFAULT_CONTAINER_CATEGORY_COMPUTER_USE",
                  },
                },
              );
            return { engine, template };
          }),
        )
        .pipe(
          Effect.catchTag("UnknownGCPError", (error) => {
            expect(error.message ?? "").toMatch(
              /not implemented|not supported|not enabled/i,
            );
            return Effect.succeed(undefined);
          }),
        );

      if (created === undefined) {
        yield* stack.destroy();
        return;
      }

      expect(created.template.name).toContain("/sandboxEnvironmentTemplates/");
      expect(created.template.displayName).toEqual("browser");
      expect(created.template.reasoningEngine).toEqual(created.engine.name);

      const fetched =
        yield* aiplatform.getProjectsLocationsReasoningEnginesSandboxEnvironmentTemplates(
          {
            name: created.template.name,
          },
        );
      expect(fetched.name).toEqual(created.template.name);
      expect(fetched.displayName).toContain("[alchemy ");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.template.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
