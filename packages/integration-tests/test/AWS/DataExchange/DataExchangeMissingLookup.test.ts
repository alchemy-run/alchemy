import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:dataexchange", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (data set).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-data-set": AWS.DataExchange.DataSet.lookup({
          dataSetId: "0123456789abcdef0123456789abcdef",
        }).dataSetId,
      });
    }),
  { tags, timeout: 180_000 },
);
