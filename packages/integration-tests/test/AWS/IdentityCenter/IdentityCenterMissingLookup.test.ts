import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:identitycenter", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (group, permission set).
// The testing account can't use IdentityCenter; an entitled account sets the gate.
test.provider.skipIf(!process.env.ALCHEMY_TEST_IDENTITY_CENTER)(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-group": AWS.IdentityCenter.Group.lookup({
          identityStoreId: "d-0000000000",
          displayName: name,
        }).identityStoreId,
        "missing-permission-set": AWS.IdentityCenter.PermissionSet.lookup({ name: name })
          .permissionSetArn,
      });
    }),
  { tags, timeout: 180_000 },
);
