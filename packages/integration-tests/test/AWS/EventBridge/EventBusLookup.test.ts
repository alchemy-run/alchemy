import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:eventbridge", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "EventBusLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const bus = yield* AWS.EventBridge.EventBus("lookup-target");
    return {
      eventBusName: bus.eventBusName.as<string>(),
      eventBusArn: bus.eventBusArn.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up event bus resolves by name, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { eventBusName, eventBusArn } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          const bus = AWS.EventBridge.EventBus.lookup({ eventBusName });
          return { arn: bus.eventBusArn };
        },
        {
          arn: eventBusArn,
        },
      );
      const survivor = yield* eventbridge.describeEventBus({ Name: eventBusName });
      expect(survivor.Arn).toBe(eventBusArn);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing event bus fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          AWS.SSM.Parameter("missing-event-bus", {
            value: AWS.EventBridge.EventBus.lookup({ eventBusName: name }).eventBusArn,
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of an event bus this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => AWS.EventBridge.EventBus("lookup-managed");
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-event-bus-consumer", {
              value: AWS.EventBridge.EventBus.lookup({ eventBusName: attrs.eventBusName })
                .eventBusArn,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
