import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:opensearchserverless", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (collection, collection group, VPC endpoint).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-collection": AWS.OpenSearchServerless.Collection.lookup({
          collectionName: name.slice(0, 32),
        }).collectionArn,
        "missing-endpoint": AWS.OpenSearchServerless.VpcEndpoint.lookup({
          endpointName: name.slice(0, 32),
        }).vpcEndpointId,
        "missing-collection-group": AWS.OpenSearchServerless.CollectionGroup.lookup({
          collectionGroupName: name.slice(0, 32),
        }).collectionGroupId,
      });
    }),
  { tags, timeout: 180_000 },
);
