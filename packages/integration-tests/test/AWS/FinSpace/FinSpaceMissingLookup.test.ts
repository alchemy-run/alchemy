import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:finspace", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (Kx cluster, Kx database, Kx environment, environment).
// The testing account can't use FinSpace; an entitled account sets the gate.
test.provider.skipIf(!process.env.AWS_TEST_FINSPACE)(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-environment": AWS.FinSpace.Environment.lookup({ environmentId: name })
          .environmentId,
        "missing-kx-cluster": AWS.FinSpace.KxCluster.lookup({
          environmentId: name,
          clusterName: name,
        }).environmentId,
        "missing-kx-database": AWS.FinSpace.KxDatabase.lookup({
          environmentId: name,
          databaseName: name,
        }).environmentId,
        "missing-kx-environment": AWS.FinSpace.KxEnvironment.lookup({ environmentId: name })
          .environmentId,
      });
    }),
  { tags, timeout: 180_000 },
);
