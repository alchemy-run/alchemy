import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:kendra", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (data source, index).
// The testing account can't use Kendra; an entitled account sets the gate.
test.provider.skipIf(!process.env.AWS_TEST_KENDRA)(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-data-source": AWS.Kendra.DataSource.lookup({
          indexId: "11111111-1111-4111-8111-111111111111",
          id: "11111111-1111-4111-8111-111111111111",
        }).id,
        "missing-index": AWS.Kendra.Index.lookup({ id: "11111111-1111-4111-8111-111111111111" }).id,
      });
    }),
  { tags, timeout: 180_000 },
);
