import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:dns", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-managed-zone": GCP.DNS.ManagedZone.lookup({ zoneName: name }).zoneName,
        "missing-policy": GCP.DNS.Policy.lookup({ policyName: name }).policyName,
        "missing-response-policy": GCP.DNS.ResponsePolicy.lookup({ responsePolicyName: name })
          .responsePolicyName,
        "missing-response-policy-rule": GCP.DNS.ResponsePolicyRule.lookup({
          ruleName: name,
          responsePolicy: name,
        }).project,
      });
    }),
  { tags, timeout: 120000 },
);
