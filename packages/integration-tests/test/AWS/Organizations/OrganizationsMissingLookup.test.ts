import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:organizations", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (account, organizational unit, policy).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const { accountId, region } = yield* AWSEnvironment.current;
      yield* expectAllMissing(stack, {
        // Not 000000000000: that is the emulator's own account, which an
        // organization another suite created already holds.
        "missing-account": AWS.Organizations.Account.lookup({ accountId: "000000000001" })
          .accountId,
        "missing-organizational-unit": AWS.Organizations.OrganizationalUnit.lookup({
          ouId: "ou-aaaa-aaaaaaaa",
        }).ouId,
        "missing-policy": AWS.Organizations.Policy.lookup({ type: "SERVICE_CONTROL_POLICY", name })
          .policyId,
      });
    }),
  { tags, timeout: 180_000 },
);
