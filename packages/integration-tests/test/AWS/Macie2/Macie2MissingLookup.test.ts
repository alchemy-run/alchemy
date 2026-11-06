import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:macie2", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (allow list, custom data identifier, findings filter).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-allow-list": AWS.Macie2.AllowList.lookup({ allowListId: "aaaaaaaaaaaaaaaaaaaaaa" })
          .id,
        "missing-custom-data-identifier": AWS.Macie2.CustomDataIdentifier.lookup({
          customDataIdentifierId: "11111111-1111-4111-8111-111111111111",
        }).id,
        "missing-findings-filter": AWS.Macie2.FindingsFilter.lookup({
          findingsFilterId: "11111111-1111-4111-8111-111111111111",
        }).id,
      });
    }),
  { tags, timeout: 180_000 },
);
