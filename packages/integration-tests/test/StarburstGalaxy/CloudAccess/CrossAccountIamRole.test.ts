import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { expectGone, freshStack } from "../helpers.ts";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

// Galaxy assumes the role when it is registered, so the lifecycle needs an
// AWS IAM role whose trust policy names Starburst's account and Galaxy's
// external ID (see CrossAccountIamRoleTrust): its ARN in
// STARBURST_GALAXY_TEST_IAM_ROLE_ARN.
const roleArn = process.env.STARBURST_GALAXY_TEST_IAM_ROLE_ARN;

const registered = (arn: string) =>
  galaxy.crossAccountIamRole.listCrossAccountIamRoles.items({}).pipe(
    Stream.filter((role) => role.awsIamArn === arn),
    Stream.runHead,
    Effect.map((found) => found._tag === "Some"),
  );

test.provider(
  "a role Galaxy cannot assume is refused at registration",
  (stack) =>
    Effect.gen(function* () {
      yield* freshStack(stack);
      const arn = "arn:aws:iam::123456789012:role/alchemy-test-untrusted";
      const exit = yield* stack
        .deploy(StarburstGalaxy.CloudAccess.CrossAccountIamRole("Untrusted", { roleArn: arn }))
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(Exit.isFailure(exit) && exit.cause)).toContain("Unable to assume role");
      expect(yield* registered(arn)).toBe(false);
      yield* stack.destroy();
    }).pipe(Effect.scoped),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:cross-account-iam-role", "live"],
    timeout: 300_000,
  },
);

test.provider.skipIf(!roleArn)(
  "register a trusted role, replace it on a new alias, and remove it",
  (stack) =>
    Effect.gen(function* () {
      yield* freshStack(stack);
      const created = yield* stack.deploy(
        StarburstGalaxy.CloudAccess.CrossAccountIamRole("Lake", { roleArn: roleArn! }),
      );
      expect(created.roleArn).toBe(roleArn);
      expect(created.dependants).toEqual([]);
      expect(yield* registered(roleArn!)).toBe(true);

      const renamed = yield* stack.deploy(
        StarburstGalaxy.CloudAccess.CrossAccountIamRole("Lake", {
          roleArn: roleArn!,
          aliasName: "alchemy_lake",
        }),
      );
      expect(renamed.aliasName).toBe("alchemy_lake");

      yield* stack.destroy();
      yield* expectGone(registered(roleArn!));
    }).pipe(Effect.scoped),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:cross-account-iam-role", "live"],
    timeout: 420_000,
  },
);
