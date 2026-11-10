import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:cloudmap", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (private DNS namespace, public DNS namespace).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-private-dns-namespace": AWS.CloudMap.PrivateDnsNamespace.lookup({
          namespaceName: name,
        }).namespaceId,
        "missing-public-dns-namespace": AWS.CloudMap.PublicDnsNamespace.lookup({
          namespaceName: name,
        }).namespaceId,
      });
    }),
  { tags, timeout: 180_000 },
);
