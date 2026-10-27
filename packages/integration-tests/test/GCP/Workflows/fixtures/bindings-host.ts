import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { probeParam, serveProbes } from "../../bindingHost.ts";

/**
 * Workflow that echoes its `name` argument, or with `wait: true` sleeps for
 * five minutes so a test can cancel it.
 */
export const Greet = GCP.Workflows.Workflow("Greet", {
  location: "us-central1",
  sourceContents: `main:
  params: [args]
  steps:
    - maybeWait:
        switch:
          - condition: \${"wait" in args}
            steps:
              - sleep:
                  call: sys.sleep
                  args:
                    seconds: 300
    - done:
        return: \${"hello " + args.name}
`,
});

/**
 * Effect-native Cloud Run service exercising the Workflows bindings as its
 * own runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class WorkflowsBindingsHost extends GCP.Function<WorkflowsBindingsHost>()(
  "WorkflowsBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const createExecution = yield* GCP.Workflows.CreateExecution(Greet);
    const getWorkflow = yield* GCP.Workflows.GetWorkflow(Greet);
    const listRevisions = yield* GCP.Workflows.ListWorkflowRevisions(Greet);
    const listExecutions = yield* GCP.Workflows.ListWorkflowExecutions(Greet);
    const getExecution = yield* GCP.Workflows.GetWorkflowExecution(Greet);
    const cancelExecution = yield* GCP.Workflows.CancelWorkflowExecution(Greet);
    const listStepEntries = yield* GCP.Workflows.ListWorkflowExecutionStepEntries(Greet);
    const getStepEntry = yield* GCP.Workflows.GetWorkflowExecutionStepEntry(Greet);
    const triggerPubsub = yield* GCP.Workflows.TriggerWorkflowPubsubExecution(Greet);

    const execution = probeParam("execution");

    return {
      fetch: serveProbes({
        createExecution: createExecution({
          body: { argument: JSON.stringify({ name: "alchemy" }) },
        }),
        startWaiting: createExecution({
          body: { argument: JSON.stringify({ name: "waiter", wait: true }) },
        }),
        workflow: Effect.all({ workflow: getWorkflow(), revisions: listRevisions() }),
        listExecutions: listExecutions(),
        getExecution: Effect.flatMap(execution, (execution) => getExecution({ execution })),
        cancelExecution: Effect.flatMap(execution, (execution) =>
          cancelExecution({ execution, body: {} }),
        ),
        stepEntries: Effect.gen(function* () {
          const id = yield* execution;
          const listed = yield* listStepEntries({ execution: id });
          const first = listed.stepEntries?.[0]?.name?.split("/").at(-1) ?? "";
          const one = yield* getStepEntry({ execution: id, stepEntry: first });
          return { listed, one };
        }),
        // The push Eventarc delivers for a Cloud Storage notification; the
        // execution's argument is the CloudEvent built from it.
        triggerPubsub: triggerPubsub({
          body: {
            GCPCloudEventsMode: "GCS_NOTIFICATION",
            subscription: "projects/alchemy/subscriptions/workflows-binding",
            message: {
              messageId: "1",
              publishTime: "2026-01-01T00:00:00Z",
              data: btoa(JSON.stringify({ kind: "storage#object", bucket: "b", name: "o" })),
              attributes: {
                eventType: "OBJECT_FINALIZE",
                bucketId: "b",
                objectId: "o",
                payloadFormat: "JSON_API_V1",
                notificationConfig: "projects/_/buckets/b/notificationConfigs/1",
                objectGeneration: "1",
                eventTime: "2026-01-01T00:00:00Z",
              },
            },
          },
        }),
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        GCP.Workflows.CreateExecutionHttp,
        GCP.Workflows.GetWorkflowHttp,
        GCP.Workflows.ListWorkflowRevisionsHttp,
        GCP.Workflows.ListWorkflowExecutionsHttp,
        GCP.Workflows.GetWorkflowExecutionHttp,
        GCP.Workflows.CancelWorkflowExecutionHttp,
        GCP.Workflows.ListWorkflowExecutionStepEntriesHttp,
        GCP.Workflows.GetWorkflowExecutionStepEntryHttp,
        GCP.Workflows.TriggerWorkflowPubsubExecutionHttp,
      ),
    ),
  ),
) {}
