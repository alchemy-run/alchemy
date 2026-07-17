import * as AWS from "@/AWS";
import { PermissionSet } from "@/AWS/IdentityCenter";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Requires an enabled IAM Identity Center (SSO) instance in the testing
// account. Without one, `resolveInstance` fails with:
//   Error: "Unable to resolve a single visible Identity Center instance;
//           pass instanceArn explicitly"
// Gate the live lifecycle behind an env var so an entitled account runs it
// unchanged.
test.provider.skipIf(!process.env.AWS_TEST_SSO_INSTANCE)(
  "list enumerates the deployed permission set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const permissionSet = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* PermissionSet("ListPermissionSet", {
            name: "alchemy-test-list-permission-set",
            description: "list() coverage test",
            sessionDuration: "PT1H",
          });
        }),
      );

      const provider = yield* Provider.findProvider(PermissionSet);
      const all = yield* provider.list();

      const found = all.find(
        (p) => p.permissionSetArn === permissionSet.permissionSetArn,
      );
      expect(found).toBeDefined();
      expect(found?.name).toBe(permissionSet.name);
      expect(found?.instanceArn).toBe(permissionSet.instanceArn);

      yield* stack.destroy();
    }),
);
