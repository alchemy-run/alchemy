import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as iam from "@distilled.cloud/aws/iam";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:iam", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "RoleLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const role = yield* AWS.IAM.Role("lookup-target", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
    });
    return {
      roleName: role.roleName.as<string>(),
      roleArn: role.roleArn.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up role resolves by name and by ARN, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { roleName, roleArn } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          const byName = AWS.IAM.Role.lookup({ roleName });
          const byArn = AWS.IAM.Role.lookup({ roleArn });
          return { arn: byName.roleArn, name: byArn.roleName };
        },
        {
          arn: roleArn,
          name: roleName,
        },
      );
      const survivor = yield* iam.getRole({ RoleName: roleName });
      expect(survivor.Role?.Arn).toBe(roleArn);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing role fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          AWS.SSM.Parameter("missing-role", {
            value: AWS.IAM.Role.lookup({ roleName: name }).roleArn,
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a role this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () =>
        AWS.IAM.Role("lookup-managed", {
          assumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: { Service: "lambda.amazonaws.com" },
                Action: ["sts:AssumeRole"],
              },
            ],
          },
        });
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-role-consumer", {
              value: AWS.IAM.Role.lookup({ roleName: attrs.roleName }).roleArn,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
