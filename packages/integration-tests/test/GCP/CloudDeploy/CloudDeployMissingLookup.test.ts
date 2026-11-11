import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:clouddeploy", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-custom-target-type": GCP.CloudDeploy.CustomTargetType.lookup({
          customTargetTypeId: name,
        }).name,
        "missing-delivery-pipeline": GCP.CloudDeploy.DeliveryPipeline.lookup({
          deliveryPipelineId: name,
        }).name,
        "missing-delivery-pipelines-automation": GCP.CloudDeploy.DeliveryPipelinesAutomation.lookup(
          { automationId: name, deliveryPipeline: name },
        ).name,
        "missing-deploy-policy": GCP.CloudDeploy.DeployPolicy.lookup({ deployPolicyId: name }).name,
        "missing-target": GCP.CloudDeploy.Target.lookup({ targetId: name }).name,
      });
    }),
  { tags, timeout: 135000 },
);
