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
  "PolicyLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const policy = yield* AWS.IAM.Policy("lookup-target", {
      policyDocument: {
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: ["s3:ListAllMyBuckets"], Resource: ["*"] }],
      },
    });
    return {
      policyName: policy.policyName.as<string>(),
      policyArn: policy.policyArn.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up policy resolves by name and by ARN, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { policyName, policyArn } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          const byName = AWS.IAM.Policy.lookup({ policyName });
          const byArn = AWS.IAM.Policy.lookup({ policyArn });
          return { arn: byName.policyArn, name: byArn.policyName };
        },
        {
          arn: policyArn,
          name: policyName,
        },
      );
      const survivor = yield* iam.getPolicy({ PolicyArn: policyArn });
      expect(survivor.Policy?.PolicyName).toBe(policyName);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "an AWS managed policy resolves by ARN",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { policyName, policyArn } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          const readOnly = AWS.IAM.Policy.lookup({
            policyArn: "arn:aws:iam::aws:policy/ReadOnlyAccess",
          });
          return { name: readOnly.policyName };
        },
        {
          name: "ReadOnlyAccess",
        },
      );
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing policy fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          AWS.SSM.Parameter("missing-policy", {
            value: AWS.IAM.Policy.lookup({ policyName: name }).policyArn,
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a policy this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () =>
        AWS.IAM.Policy("lookup-managed", {
          policyDocument: {
            Version: "2012-10-17",
            Statement: [{ Effect: "Allow", Action: ["s3:ListAllMyBuckets"], Resource: ["*"] }],
          },
        });
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-policy-consumer", {
              value: AWS.IAM.Policy.lookup({ policyArn: attrs.policyArn }).policyArn,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
