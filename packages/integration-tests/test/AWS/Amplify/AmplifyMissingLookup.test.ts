import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:amplify", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (app, branch).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-app": AWS.Amplify.App.lookup({ appId: "d0000000000000" }).appId,
        "missing-branch": AWS.Amplify.Branch.lookup({ appId: "d0000000000000", branchName: name })
          .appId,
      });
    }),
  { tags, timeout: 180_000 },
);
