import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as servicebus from "@distilled.cloud/azure/servicebus";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getTopic = (
  resourceGroupName: string,
  namespaceName: string,
  topicName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* servicebus.GetTopic({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      topicName,
    });
  });

const topicGone = (
  resourceGroupName: string,
  namespaceName: string,
  topicName: string,
) =>
  getTopic(resourceGroupName, namespaceName, topicName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

const program = (props: {
  requiresDuplicateDetection: boolean;
  supportOrdering: boolean;
  defaultMessageTimeToLive: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const bus = yield* Azure.ServiceBus.Namespace("Bus", {
      resourceGroup: group.resourceGroupName,
      sku: "Standard",
    });
    const events = yield* Azure.ServiceBus.Topic("Events", {
      resourceGroup: group.resourceGroupName,
      namespace: bus.namespaceName,
      ...props,
    });
    return { group, bus, events };
  });

// Standard namespace + one topic: ~$0.0135/h, a few minutes per run (<$0.01).
test.provider(
  "create, update, replace, and delete a service bus topic",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, bus, events } = yield* stack.deploy(
        program({
          requiresDuplicateDetection: false,
          supportOrdering: true,
          defaultMessageTimeToLive: "P7D",
        }),
      );
      const rg = group.resourceGroupName;
      expect(events.topicName).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
      const observed = yield* getTopic(rg, bus.namespaceName, events.topicName);
      expect(observed.properties?.supportOrdering).toEqual(true);
      expect(observed.properties?.defaultMessageTimeToLive).toEqual("P7D");
      expect(observed.properties?.userMetadata).toMatch(
        /^\[alchemy .+\/Events\]$/,
      );

      // In place: ordering and TTL.
      const updated = yield* stack.deploy(
        program({
          requiresDuplicateDetection: false,
          supportOrdering: false,
          defaultMessageTimeToLive: "P1D",
        }),
      );
      expect(updated.events.topicName).toEqual(events.topicName);
      const reobserved = yield* getTopic(
        rg,
        bus.namespaceName,
        events.topicName,
      );
      expect(reobserved.properties?.supportOrdering).toEqual(false);
      expect(reobserved.properties?.defaultMessageTimeToLive).toEqual("P1D");

      // Replacement: duplicate detection is immutable.
      const replaced = yield* stack.deploy(
        program({
          requiresDuplicateDetection: true,
          supportOrdering: false,
          defaultMessageTimeToLive: "P1D",
        }),
      );
      expect(replaced.events.topicName).not.toEqual(events.topicName);
      const dedup = yield* getTopic(
        rg,
        bus.namespaceName,
        replaced.events.topicName,
      );
      expect(dedup.properties?.requiresDuplicateDetection).toEqual(true);
      expect(yield* topicGone(rg, bus.namespaceName, events.topicName)).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* topicGone(rg, bus.namespaceName, replaced.events.topicName),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:servicebus", "live"],
    timeout: 600_000,
  },
);
