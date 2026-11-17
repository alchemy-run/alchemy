import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:logs", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "LogGroupLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const group = yield* AWS.Logs.LogGroup("lookup-target");
    return {
      logGroupName: group.logGroupName.as<string>(),
      logGroupArn: group.logGroupArn.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up log group resolves by name, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { logGroupName, logGroupArn } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          const group = AWS.Logs.LogGroup.lookup({ logGroupName });
          return { arn: group.logGroupArn };
        },
        {
          arn: logGroupArn,
        },
      );
      const { logGroups } = yield* logs.describeLogGroups({ logGroupNamePrefix: logGroupName });
      expect(logGroups?.map((g) => g.logGroupName)).toContain(logGroupName);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing log group fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          AWS.SSM.Parameter("missing-log-group", {
            value: AWS.Logs.LogGroup.lookup({ logGroupName: name }).logGroupArn,
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a log group this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => AWS.Logs.LogGroup("lookup-managed");
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-log-group-consumer", {
              value: AWS.Logs.LogGroup.lookup({ logGroupName: attrs.logGroupName }).logGroupArn,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
