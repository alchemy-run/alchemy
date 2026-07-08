import * as AWS from "@/AWS";
import { Policy } from "@/AWS/Organizations";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// `listPolicies` requires a `Filter` (policy type), so `list()` fans out across
// every policy-type filter and hydrates each policy via `describePolicy` into the
// exact `read` shape. This runs read-only: when the account is an org management
// account, AWS-managed SCPs like `FullAWSAccess` appear; otherwise `list()`
// degrades to `[]` via the typed `AWSOrganizationsNotInUseException` /
// `AccessDeniedException` catches, so the assertions hold without deploying.
test.provider("list enumerates organization policies", (stack) =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(Policy);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);

    for (const policy of all) {
      expect(typeof policy.policyId).toBe("string");
      expect(policy.policyId.length).toBeGreaterThan(0);
      expect(typeof policy.policyArn).toBe("string");
      expect(policy.policyArn.startsWith("arn:aws")).toBe(true);
      expect(typeof policy.name).toBe("string");
      expect(policy.document).toBeDefined();
      expect(policy.tags).toBeDefined();
    }

    yield* stack.destroy();
  }),
);
