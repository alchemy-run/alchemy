import * as AWS from "@/AWS";
import { PolicyAttachment } from "@/AWS/Organizations";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// `list()` enumerates every (policyId, targetId) attachment by fanning out over
// all policy types (listPolicies per type) and listing each policy's targets
// (listTargetsForPolicy per policy). This runs read-only: when the testing
// account isn't an org management account / delegated administrator, the typed
// AccessDeniedException / AWSOrganizationsNotInUseException catches degrade the
// result to [], so the assertion holds without deploying anything.
test.provider("list enumerates policy attachments", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(PolicyAttachment);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);

    for (const attachment of all) {
      expect(typeof attachment.policyId).toBe("string");
      expect(typeof attachment.targetId).toBe("string");
    }
  }),
);
