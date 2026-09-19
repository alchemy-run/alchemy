import { Action } from "@/Action";
import * as GCP from "@/GCP";
import type { StackServices } from "@/Stack";
import * as Test from "@/Test/Alchemy";
import * as workflowexecutions from "@distilled.cloud/gcp/workflowexecutions_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

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

const SOURCE = `main:
  steps:
    - done:
        return: hello
`;

test.provider.skipIf(!hasGcpCreds)(
  "CreateExecution starts a workflow run",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const started = yield* stack.deploy(
        Effect.gen(function* () {
          const workflow = yield* GCP.Workflows.Workflow("Greet", {
            location: "us-central1",
            sourceContents: SOURCE,
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* workflow.name;
              const createExecution =
                yield* GCP.Workflows.CreateExecution(workflow);
              return Effect.fn(function* () {
                return yield* createExecution();
              });
            }),
          );
          return yield* Probe({});
        }),
      );

      expect(started.name).toContain("/executions/");

      const finished = yield* workflowexecutions
        .getProjectsLocationsWorkflowsExecutions({
          name: started.name ?? "",
        })
        .pipe(
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (execution) =>
              execution.state === "SUCCEEDED" ||
              execution.state === "FAILED" ||
              execution.state === "CANCELLED",
            times: 10,
          }),
        );
      expect(finished.state).toEqual("SUCCEEDED");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
