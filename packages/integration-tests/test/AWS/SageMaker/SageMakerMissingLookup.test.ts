import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:sagemaker", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (cluster, compute quota, endpoint, endpoint config, feature group, model).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-cluster": AWS.SageMaker.Cluster.lookup({ clusterName: name }).clusterName,
        "missing-compute-quota": AWS.SageMaker.ComputeQuota.lookup({
          computeQuotaId: "aaaaaaaaaaaa",
        }).computeQuotaId,
        "missing-endpoint": AWS.SageMaker.Endpoint.lookup({ endpointName: name }).endpointName,
        "missing-endpoint-config": AWS.SageMaker.EndpointConfig.lookup({ endpointConfigName: name })
          .endpointConfigName,
        "missing-feature-group": AWS.SageMaker.FeatureGroup.lookup({ featureGroupName: name })
          .featureGroupName,
        "missing-model": AWS.SageMaker.Model.lookup({ modelName: name }).modelName,
      });
    }),
  { tags, timeout: 180_000 },
);
