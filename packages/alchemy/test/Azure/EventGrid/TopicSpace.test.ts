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

const getSpace = (
  resourceGroupName: string,
  namespaceName: string,
  topicSpaceName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* eventgrid.GetTopicSpace({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      topicSpaceName,
    });
  });

const spaceGone = (
  resourceGroupName: string,
  namespaceName: string,
  topicSpaceName: string,
) =>
  getSpace(resourceGroupName, namespaceName, topicSpaceName).pipe(
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
  topicTemplates: string[];
  description?: string;
  name?: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const namespace = yield* Azure.EventGrid.Namespace("Broker", {
      resourceGroup: group.resourceGroupName,
      topicSpacesConfiguration: { state: "Enabled" },
    });
    const topicSpace = yield* Azure.EventGrid.TopicSpace("Telemetry", {
      resourceGroup: group.resourceGroupName,
      namespace: namespace.namespaceName,
      name: props.name,
      topicTemplates: props.topicTemplates,
      description: props.description,
    });
    return { group, namespace, topicSpace };
  });

// One throughput unit with the MQTT broker for ~10 minutes; well under $0.10.
test.provider(
  "create, update, rename, and delete an event grid MQTT topic space",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, namespace, topicSpace } = yield* stack.deploy(
        program({ topicTemplates: ["devices/+/telemetry"] }),
      );
      expect(topicSpace.topicTemplates).toEqual(["devices/+/telemetry"]);
      const observed = yield* getSpace(
        group.resourceGroupName,
        namespace.namespaceName,
        topicSpace.topicSpaceName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");

      // In place: topic templates and description.
      const updated = yield* stack.deploy(
        program({
          topicTemplates: [
            "devices/+/telemetry",
            "devices/${client.authenticationName}/status",
          ],
          description: "device topics",
        }),
      );
      expect(updated.topicSpace.topicSpaceName).toEqual(
        topicSpace.topicSpaceName,
      );
      expect(updated.topicSpace.description).toEqual("device topics");
      const reobserved = yield* getSpace(
        group.resourceGroupName,
        namespace.namespaceName,
        topicSpace.topicSpaceName,
      );
      expect([...(reobserved.properties?.topicTemplates ?? [])].sort()).toEqual(
        [
          "devices/${client.authenticationName}/status",
          "devices/+/telemetry",
        ].sort(),
      );

      // Renaming replaces the topic space.
      const renamed = yield* stack.deploy(
        program({
          topicTemplates: ["devices/+/telemetry"],
          name: "telemetry-renamed",
        }),
      );
      expect(renamed.topicSpace.topicSpaceName).toEqual("telemetry-renamed");
      expect(
        yield* spaceGone(
          group.resourceGroupName,
          namespace.namespaceName,
          topicSpace.topicSpaceName,
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* spaceGone(
          group.resourceGroupName,
          namespace.namespaceName,
          "telemetry-renamed",
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:eventgrid", "live"],
    timeout: 600_000,
  },
);
