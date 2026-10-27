import * as GCP from "@alchemy.run/gcp";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as crm from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as workflowexecutions from "@distilled.cloud/gcp/workflowexecutions_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { expectProbe } from "../bindingHost.ts";
import WorkflowsBindingsHost, { Greet } from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "WorkflowsBindings");

let baseUrl: string;
let hostAccount: string;
let project: string;
let workflowName: string;

/**
 * Workflows has no per-workflow IAM policy: the bindings grant
 * roles/workflows.invoker (executions) and roles/workflows.viewer (the
 * workflow itself) on the project.
 */
const expectProjectGrants = Effect.gen(function* () {
  const policy = yield* crm.getIamPolicyProjects({
    resource: `projects/${project}`,
    body: { options: { requestedPolicyVersion: 3 } },
  });
  const roles = (policy.bindings ?? [])
    .filter((binding) => (binding.members ?? []).includes(`serviceAccount:${hostAccount}`))
    .map((binding) => ({ role: binding.role, condition: binding.condition }))
    .sort((a, b) => (a.role ?? "").localeCompare(b.role ?? ""));
  expect(roles).toEqual([
    { role: "roles/workflows.invoker", condition: undefined },
    { role: "roles/workflows.viewer", condition: undefined },
  ]);
});

const executionId = (execution: workflowexecutions.Execution) => execution.name!.split("/").at(-1)!;

describe(
  "Workflows Bindings",
  {
    tags: ["provider:gcp", "provider:gcp:workflows", "provider:gcp:run", "live"],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* WorkflowsBindingsHost;
            const workflow = yield* Greet;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              name: workflow.name,
              project: workflow.project,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        workflowName = out.name;
        project = out.project;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    const live = {
      tags: ["provider:gcp", "provider:gcp:workflows", "live"],
      timeout: 600_000,
    };

    describe("CreateExecution", () => {
      test.provider(
        "starts a run as the host's service account, granted workflows.invoker on the project",
        (_stack) =>
          Effect.gen(function* () {
            const started = yield* expectProbe<workflowexecutions.Execution>(
              baseUrl,
              "createExecution",
            );
            // Execution names carry the project number, not its id.
            const workflowPath = workflowName.slice(workflowName.indexOf("/locations/"));
            expect(started.name).toEqual(expect.stringContaining(`${workflowPath}/executions/`));

            const finished = yield* workflowexecutions
              .getProjectsLocationsWorkflowsExecutions({
                name: started.name ?? "",
              })
              .pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("2 seconds"),
                  until: (execution) => execution.state !== "ACTIVE",
                  times: 30,
                }),
              );
            expect(finished.state).toEqual("SUCCEEDED");
            expect(finished.result).toEqual(JSON.stringify("hello alchemy"));

            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:workflows", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetWorkflow / ListWorkflowRevisions", () => {
      test.provider(
        "reads the workflow and its revisions as the host",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              workflow: { name?: string; revisionId?: string };
              revisions: { workflows?: { revisionId?: string }[] };
            }>(baseUrl, "workflow");
            expect(out.workflow.name).toEqual(workflowName);
            expect(out.revisions.workflows?.map((w) => w.revisionId)).toContain(
              out.workflow.revisionId,
            );
            yield* expectProjectGrants;
          }),
        live,
      );
    });

    describe("ListWorkflowExecutions / GetWorkflowExecution / ListWorkflowExecutionStepEntries / GetWorkflowExecutionStepEntry", () => {
      test.provider(
        "inspects a finished execution as the host",
        (_stack) =>
          Effect.gen(function* () {
            const started = yield* expectProbe<workflowexecutions.Execution>(
              baseUrl,
              "createExecution",
            );
            const id = executionId(started);
            const finished = yield* expectProbe<workflowexecutions.Execution>(
              baseUrl,
              `getExecution?execution=${id}`,
            ).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("2 seconds"),
                until: (execution) => execution.state !== "ACTIVE",
                times: 30,
              }),
            );
            expect(finished).toMatchObject({
              state: "SUCCEEDED",
              result: JSON.stringify("hello alchemy"),
            });

            const listed = yield* expectProbe<{ executions?: { name?: string }[] }>(
              baseUrl,
              "listExecutions",
            );
            expect(listed.executions?.map((e) => e.name)).toContain(started.name);

            const steps = yield* expectProbe<{
              listed: { stepEntries?: { name?: string; step?: string }[] };
              one: { name?: string; step?: string };
            }>(baseUrl, `stepEntries?execution=${id}`);
            expect(steps.listed.stepEntries?.map((s) => s.step)).toEqual(
              expect.arrayContaining(["maybeWait", "done"]),
            );
            expect(steps.one.name).toEqual(steps.listed.stepEntries?.[0]?.name);

            yield* expectProjectGrants;
          }),
        live,
      );
    });

    describe("CancelWorkflowExecution / TriggerWorkflowPubsubExecution", () => {
      test.provider(
        "cancels a waiting execution and starts one from a Pub/Sub message as the host",
        (_stack) =>
          Effect.gen(function* () {
            const waiting = yield* expectProbe<workflowexecutions.Execution>(
              baseUrl,
              "startWaiting",
            );
            const cancelled = yield* expectProbe<workflowexecutions.Execution>(
              baseUrl,
              `cancelExecution?execution=${executionId(waiting)}`,
            );
            expect(cancelled.state).toEqual("CANCELLED");

            const triggered = yield* expectProbe<workflowexecutions.Execution>(
              baseUrl,
              "triggerPubsub",
            );
            const workflowPath = workflowName.slice(workflowName.indexOf("/locations/"));
            expect(triggered.name).toEqual(expect.stringContaining(`${workflowPath}/executions/`));
            expect(JSON.parse(triggered.argument ?? "{}")).toMatchObject({
              bucket: "b",
              data: { name: "o" },
            });
            yield* expectProjectGrants;
          }),
        live,
      );
    });
  },
);
