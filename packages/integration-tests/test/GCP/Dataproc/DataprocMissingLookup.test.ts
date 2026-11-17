import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:dataproc", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-autoscaling-policy": GCP.Dataproc.AutoscalingPolicy.lookup({ policyId: name })
          .name,
        "missing-batch": GCP.Dataproc.Batch.lookup({ batchId: name }).name,
        "missing-cluster": GCP.Dataproc.Cluster.lookup({ clusterName: name }).name,
        "missing-session": GCP.Dataproc.Session.lookup({ sessionId: name }).name,
        "missing-session-template": GCP.Dataproc.SessionTemplate.lookup({ templateId: name }).name,
        "missing-workflow-template": GCP.Dataproc.WorkflowTemplate.lookup({ templateId: name })
          .name,
      });
    }),
  { tags, timeout: 150000 },
);
