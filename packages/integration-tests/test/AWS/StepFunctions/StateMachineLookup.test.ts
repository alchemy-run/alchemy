import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as sfn from "@distilled.cloud/aws/sfn";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:stepfunctions", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "StateMachineLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const machine = yield* AWS.StepFunctions.StateMachine("lookup-target", {
      definition: {
        StartAt: "Done",
        States: { Done: { Type: "Pass", End: true } },
      },
    });
    const activity = yield* AWS.StepFunctions.Activity("lookup-target-activity");
    return {
      stateMachineName: machine.stateMachineName.as<string>(),
      stateMachineArn: machine.stateMachineArn.as<string>(),
      activityName: activity.activityName.as<string>(),
      activityArn: activity.activityArn.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up state machine resolves by name and by ARN, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { stateMachineName, stateMachineArn, activityName, activityArn } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          const byName = AWS.StepFunctions.StateMachine.lookup({ stateMachineName });
          const byArn = AWS.StepFunctions.StateMachine.lookup({ stateMachineArn });
          return { arn: byName.stateMachineArn, name: byArn.stateMachineName };
        },
        {
          arn: stateMachineArn,
          name: stateMachineName,
        },
      );
      const survivor = yield* sfn.describeStateMachine({ stateMachineArn });
      expect(survivor.name).toBe(stateMachineName);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a looked-up activity resolves by name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { stateMachineName, stateMachineArn, activityName, activityArn } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          const activity = AWS.StepFunctions.Activity.lookup({ activityName });
          return { arn: activity.activityArn };
        },
        {
          arn: activityArn,
        },
      );
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing state machine fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          AWS.SSM.Parameter("missing-state-machine", {
            value: AWS.StepFunctions.StateMachine.lookup({ stateMachineName: name })
              .stateMachineArn,
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a state machine this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () =>
        AWS.StepFunctions.StateMachine("lookup-managed", {
          definition: {
            StartAt: "Done",
            States: { Done: { Type: "Pass", End: true } },
          },
        });
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-state-machine-consumer", {
              value: AWS.StepFunctions.StateMachine.lookup({
                stateMachineArn: attrs.stateMachineArn,
              }).stateMachineArn,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
