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
  "InstanceProfileLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const profile = yield* AWS.IAM.InstanceProfile("lookup-target");
    return {
      instanceProfileName: profile.instanceProfileName.as<string>(),
      instanceProfileArn: profile.instanceProfileArn.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up instance profile resolves by name, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { instanceProfileName, instanceProfileArn } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          const profile = AWS.IAM.InstanceProfile.lookup({ instanceProfileName });
          return { arn: profile.instanceProfileArn };
        },
        {
          arn: instanceProfileArn,
        },
      );
      const survivor = yield* iam.getInstanceProfile({ InstanceProfileName: instanceProfileName });
      expect(survivor.InstanceProfile?.Arn).toBe(instanceProfileArn);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing instance profile fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          AWS.SSM.Parameter("missing-instance-profile", {
            value: AWS.IAM.InstanceProfile.lookup({ instanceProfileName: name }).instanceProfileArn,
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of an instance profile this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => AWS.IAM.InstanceProfile("lookup-managed");
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-instance-profile-consumer", {
              value: AWS.IAM.InstanceProfile.lookup({
                instanceProfileName: attrs.instanceProfileName,
              }).instanceProfileArn,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
