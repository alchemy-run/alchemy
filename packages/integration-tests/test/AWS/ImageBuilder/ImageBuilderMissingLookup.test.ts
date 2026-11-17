import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:imagebuilder", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (component, distribution configuration, image pipeline, image recipe, infrastructure configuration).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const { accountId, region } = yield* AWSEnvironment.current;
      yield* expectAllMissing(stack, {
        "missing-component": AWS.ImageBuilder.Component.lookup({
          componentBuildVersionArn: `arn:aws:imagebuilder:${region}:${accountId}:component/missing-lookup/1.0.0/1`,
        }).componentName,
        "missing-distribution-configuration": AWS.ImageBuilder.DistributionConfiguration.lookup({
          distributionConfigurationArn: `arn:aws:imagebuilder:${region}:${accountId}:distribution-configuration/missing-lookup`,
        }).distributionConfigurationName,
        "missing-image-pipeline": AWS.ImageBuilder.ImagePipeline.lookup({
          imagePipelineArn: `arn:aws:imagebuilder:${region}:${accountId}:image-pipeline/missing-lookup`,
        }).imagePipelineName,
        "missing-image-recipe": AWS.ImageBuilder.ImageRecipe.lookup({
          imageRecipeArn: `arn:aws:imagebuilder:${region}:${accountId}:image-recipe/missing-lookup/1.0.0`,
        }).imageRecipeName,
        "missing-infrastructure-configuration": AWS.ImageBuilder.InfrastructureConfiguration.lookup(
          {
            infrastructureConfigurationArn: `arn:aws:imagebuilder:${region}:${accountId}:infrastructure-configuration/missing-lookup`,
          },
        ).infrastructureConfigurationName,
      });
    }),
  { tags, timeout: 180_000 },
);
