import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getSystemTopic = (resourceGroupName: string, systemTopicName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* eventgrid.GetSystemTopic({
      subscriptionId,
      resourceGroupName,
      systemTopicName,
    });
  });

const systemTopicGone = (resourceGroupName: string, systemTopicName: string) =>
  getSystemTopic(resourceGroupName, systemTopicName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const program = (props: {
  identity?: Azure.EventGrid.EventGridIdentity;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const systemTopic = yield* Azure.EventGrid.SystemTopic("GroupEvents", {
      resourceGroup: group.resourceGroupName,
      source: group.resourceGroupId,
      topicType: "Microsoft.Resources.ResourceGroups",
      location: "global",
      identity: props.identity,
      tags: props.tags,
    });
    return { group, systemTopic };
  });

// System topics are free; ~2 minutes.
test.provider(
  "create, update, and delete an event grid system topic",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, systemTopic } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      expect(systemTopic.location).toEqual("global");
      expect(systemTopic.topicType).toEqual(
        "Microsoft.Resources.ResourceGroups",
      );
      expect(systemTopic.source.toLowerCase()).toEqual(
        group.resourceGroupId.toLowerCase(),
      );
      expect(systemTopic.principalId).toBeUndefined();
      const observed = yield* getSystemTopic(
        group.resourceGroupName,
        systemTopic.systemTopicName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");

      // In-place: tags and a system-assigned identity.
      const updated = yield* stack.deploy(
        program({
          identity: { type: "SystemAssigned" },
          tags: { env: "prod" },
        }),
      );
      expect(updated.systemTopic.systemTopicName).toEqual(
        systemTopic.systemTopicName,
      );
      expect(updated.systemTopic.principalId).toBeDefined();
      const reobserved = yield* getSystemTopic(
        group.resourceGroupName,
        systemTopic.systemTopicName,
      );
      expect(reobserved.identity?.type).toEqual("SystemAssigned");
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* systemTopicGone(
          group.resourceGroupName,
          systemTopic.systemTopicName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:eventgrid", "live"],
    timeout: 600_000,
  },
);
