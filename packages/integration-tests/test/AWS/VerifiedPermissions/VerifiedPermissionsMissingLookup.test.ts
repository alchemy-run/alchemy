import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:verifiedpermissions", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (identity source, policy store, policy store alias, policy template).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-identity-source": AWS.VerifiedPermissions.IdentitySource.lookup({
          policyStoreId: name,
          identitySourceId: name,
        }).policyStoreId,
        "missing-policy-store": AWS.VerifiedPermissions.PolicyStore.lookup({ policyStoreId: name })
          .policyStoreId,
        "missing-policy-store-alias": AWS.VerifiedPermissions.PolicyStoreAlias.lookup({
          aliasName: `policy-store-alias/${name}`,
        }).aliasName,
        "missing-policy-template": AWS.VerifiedPermissions.PolicyTemplate.lookup({
          policyStoreId: name,
          policyTemplateId: name,
        }).policyStoreId,
      });
    }),
  { tags, timeout: 180_000 },
);
