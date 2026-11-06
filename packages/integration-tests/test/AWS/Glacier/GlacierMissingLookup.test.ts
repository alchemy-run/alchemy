import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:glacier", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (vault).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-vault": AWS.Glacier.Vault.lookup({ vaultName: name }).vaultName,
      });
    }),
  { tags, timeout: 180_000 },
);
