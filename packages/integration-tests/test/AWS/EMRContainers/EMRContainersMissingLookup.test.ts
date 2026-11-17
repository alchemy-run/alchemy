import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:emrcontainers", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (job template, virtual cluster).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-job-template": AWS.EMRContainers.JobTemplate.lookup({ jobTemplateName: name })
          .jobTemplateId,
        "missing-virtual-cluster": AWS.EMRContainers.VirtualCluster.lookup({
          virtualClusterName: name,
        }).virtualClusterId,
      });
    }),
  { tags, timeout: 180_000 },
);
