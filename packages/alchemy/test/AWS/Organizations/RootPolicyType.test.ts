import * as AWS from "@/AWS";
import { RootPolicyType } from "@/AWS/Organizations";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// A RootPolicyType is the enable/disable state of a policy type on an org root.
// `list()` enumerates roots via `listRoots` and emits one Attributes per
// (rootId, policyType). It runs read-only: outside an org management account
// `listRoots` rejects with a typed error that degrades to [], so the assertion
// holds without deploying anything.
test.provider("list enumerates root policy types", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(RootPolicyType);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);

    for (const item of all) {
      expect(typeof item.rootId).toBe("string");
      expect(item.rootId.length).toBeGreaterThan(0);
      expect(typeof item.policyType).toBe("string");
      if (item.rootArn !== undefined) {
        expect(typeof item.rootArn).toBe("string");
      }
      if (item.status !== undefined) {
        expect(typeof item.status).toBe("string");
      }
    }
  }),
);
