import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:apprunner", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (VPC connector, auto scaling configuration, observability configuration, service).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-auto-scaling-configuration": AWS.AppRunner.AutoScalingConfiguration.lookup({
          autoScalingConfigurationName: name.slice(0, 32),
        }).autoScalingConfigurationName,
        "missing-observability-configuration": AWS.AppRunner.ObservabilityConfiguration.lookup({
          observabilityConfigurationName: name.slice(0, 32),
        }).observabilityConfigurationName,
        "missing-service": AWS.AppRunner.Service.lookup({ serviceName: name }).serviceName,
        "missing-vpc-connector": AWS.AppRunner.VpcConnector.lookup({ vpcConnectorName: name })
          .vpcConnectorName,
      });
    }),
  { tags, timeout: 180_000 },
);
