import * as AWS from "@/AWS";
import { AccountPasswordPolicy } from "@/AWS/IAM";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// The IAM account password policy is an account-wide singleton. Mutating it is
// disruptive (it changes the real password requirements for every console
// user), so this ungated probe never deploys/destroys the resource. It only
// exercises `list()` and asserts the result is well-formed: the singleton get
// returns either the one configured policy or `[]` (typed `NoSuchEntityException`
// when no policy is set on the account).
test.provider("list returns the account password policy singleton", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(AccountPasswordPolicy);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);
    // Account singleton: 0 (no policy set) or 1 (policy configured).
    expect(all.length).toBeLessThanOrEqual(1);
    for (const policy of all) {
      expect(typeof policy).toBe("object");
      expect(policy).not.toBeNull();
    }
  }),
);
