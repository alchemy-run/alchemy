import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as scheduler from "@distilled.cloud/aws/scheduler";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:scheduler", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "ScheduleGroupLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const group = yield* AWS.Scheduler.ScheduleGroup("lookup-target");
    return {
      scheduleGroupName: group.scheduleGroupName.as<string>(),
      scheduleGroupArn: group.scheduleGroupArn.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up schedule group resolves by name, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { scheduleGroupName, scheduleGroupArn } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          const group = AWS.Scheduler.ScheduleGroup.lookup({ scheduleGroupName });
          return { arn: group.scheduleGroupArn };
        },
        {
          arn: scheduleGroupArn,
        },
      );
      const survivor = yield* scheduler.getScheduleGroup({ Name: scheduleGroupName });
      expect(survivor.Arn).toBe(scheduleGroupArn);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing schedule group fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          AWS.SSM.Parameter("missing-schedule-group", {
            value: AWS.Scheduler.ScheduleGroup.lookup({ scheduleGroupName: name }).scheduleGroupArn,
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a schedule group this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => AWS.Scheduler.ScheduleGroup("lookup-managed");
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-schedule-group-consumer", {
              value: AWS.Scheduler.ScheduleGroup.lookup({
                scheduleGroupName: attrs.scheduleGroupName,
              }).scheduleGroupArn,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
