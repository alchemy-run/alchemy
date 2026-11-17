import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:emr", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (cluster, security configuration, studio).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-cluster": AWS.EMR.Cluster.lookup({ clusterId: name }).clusterId,
        "missing-security-configuration": AWS.EMR.SecurityConfiguration.lookup({
          securityConfigurationName: name,
        }).securityConfigurationName,
        "missing-studio": AWS.EMR.Studio.lookup({ studioId: "es-00000000000000000000000000" })
          .studioId,
      });
    }),
  { tags, timeout: 180_000 },
);
