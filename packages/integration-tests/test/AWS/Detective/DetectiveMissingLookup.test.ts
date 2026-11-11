import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:detective", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (graph).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-graph": AWS.Detective.Graph.lookup({
          graphArn: `arn:aws:iam::000000000000:role/${name}`,
        }).graphArn,
      });
    }),
  { tags, timeout: 180_000 },
);
