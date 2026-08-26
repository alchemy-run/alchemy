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
              const queryEngine =
                yield* GCP.AIPlatform.QueryReasoningEngine(engine);
              return Effect.fn(function* () {
                const live = yield* getEngine();
                const queried = yield* queryEngine({
                  body: { input: { input: "hello" } },
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
                return { live, queried };
              });
            }),
          );
          return { engine, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.live.name).toEqual(out.engine.name);
      expect([
        "ok",
        "Forbidden",
        "BadRequest",
        "NotFound",
        "Conflict",
      ]).toContain(out.probe.queried.tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!runLifecycle)(
  "GetTrainingPipeline and CancelTrainingPipeline invoke HTTP bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const pipeline = yield* GCP.AIPlatform.TrainingPipeline("Train", {
            location: "us-central1",
            displayName: "alchemy-binding-pipeline",
            trainingTaskDefinition:
              "gs://google-cloud-aiplatform/schema/trainingjob/definition/custom_task_1.0.0.yaml",
            trainingTaskInputs: {
              workerPoolSpecs: [
                {
                  machineSpec: { machineType: "n1-standard-4" },
                  replicaCount: "1",
                  containerSpec: {
                    imageUri:
                      "us-docker.pkg.dev/vertex-ai/training/tf-cpu.2-12.py310:latest",
                    command: ["echo", "ok"],
                  },
                },
              ],
            },
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* pipeline.name;
              const getPipeline =
                yield* GCP.AIPlatform.GetTrainingPipeline(pipeline);
              const cancel =
                yield* GCP.AIPlatform.CancelTrainingPipeline(pipeline);
              return Effect.fn(function* () {
                const live = yield* getPipeline();
                const cancelled = yield* cancel({ body: {} }).pipe(
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
                return { live, cancelled };
              });
            }),
          );
          return { pipeline, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.live.name).toEqual(out.pipeline.name);
      expect([
        "ok",
        "Forbidden",
        "BadRequest",
        "NotFound",
        "Conflict",
      ]).toContain(out.probe.cancelled.tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider.skipIf(!runLifecycle)(
  "GetSandboxEnvironment and PauseSandboxEnvironment invoke HTTP bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack
        .deploy(
          Effect.gen(function* () {
            const engine = yield* GCP.AIPlatform.ReasoningEngine("Agent", {
              location: "us-central1",
              displayName: "alchemy-binding-sandbox-engine",
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
            const Probe = Action(
              "Probe",
              Effect.gen(function* () {
                yield* sandbox.name;
                const getSandbox =
                  yield* GCP.AIPlatform.GetSandboxEnvironment(sandbox);
                const pause =
                  yield* GCP.AIPlatform.PauseSandboxEnvironment(sandbox);
                const resume =
                  yield* GCP.AIPlatform.ResumeSandboxEnvironment(sandbox);
                return Effect.fn(function* () {
                  const live = yield* getSandbox();
                  const paused = yield* pause({ body: {} }).pipe(
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
                  const resumed = yield* resume({ body: {} }).pipe(
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
                  return { live, paused, resumed };
                });
              }),
            );
            return { sandbox, probe: yield* Probe({}) };
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

      expect(created.probe.live.name).toEqual(created.sandbox.name);
      expect([
        "ok",
        "Forbidden",
        "BadRequest",
        "NotFound",
        "Conflict",
      ]).toContain(created.probe.paused.tag);
      expect([
        "ok",
        "Forbidden",
        "BadRequest",
        "NotFound",
        "Conflict",
      ]).toContain(created.probe.resumed.tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider.skipIf(!runLifecycle)(
  "GetSandboxEnvironmentTemplate invokes the HTTP binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack
        .deploy(
          Effect.gen(function* () {
            const engine = yield* GCP.AIPlatform.ReasoningEngine("Agent", {
              location: "us-central1",
              displayName: "alchemy-binding-template-engine",
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
            const Probe = Action(
              "Probe",
              Effect.gen(function* () {
                yield* template.name;
                const getTemplate =
                  yield* GCP.AIPlatform.GetSandboxEnvironmentTemplate(template);
                return Effect.fn(function* () {
                  const live = yield* getTemplate();
                  return { live };
                });
              }),
            );
            return { template, probe: yield* Probe({}) };
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

      expect(created.probe.live.name).toEqual(created.template.name);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
