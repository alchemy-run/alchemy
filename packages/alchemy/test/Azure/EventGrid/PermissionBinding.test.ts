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

const getBinding = (
  resourceGroupName: string,
  namespaceName: string,
  permissionBindingName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* eventgrid.GetPermissionBinding({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      permissionBindingName,
    });
  });

const bindingGone = (
  resourceGroupName: string,
  namespaceName: string,
  permissionBindingName: string,
) =>
  getBinding(resourceGroupName, namespaceName, permissionBindingName).pipe(
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
  permission: "Publisher" | "Subscriber";
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
      topicTemplates: ["devices/+/telemetry"],
    });
    const clientGroup = yield* Azure.EventGrid.ClientGroup("Sensors", {
      resourceGroup: group.resourceGroupName,
      namespace: namespace.namespaceName,
      query: "attributes.role = 'sensor'",
    });
    const binding = yield* Azure.EventGrid.PermissionBinding("SensorsPublish", {
      resourceGroup: group.resourceGroupName,
      namespace: namespace.namespaceName,
      name: props.name,
      topicSpace: topicSpace.topicSpaceName,
      clientGroup: clientGroup.clientGroupName,
      permission: props.permission,
      description: props.description,
    });
    return { group, namespace, topicSpace, clientGroup, binding };
  });

// One throughput unit with the MQTT broker for ~10 minutes; well under $0.10.
test.provider(
  "create, update, rename, and delete an event grid MQTT permission binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, namespace, topicSpace, clientGroup, binding } =
        yield* stack.deploy(program({ permission: "Publisher" }));
      expect(binding.permission).toEqual("Publisher");
      expect(binding.topicSpace).toEqual(topicSpace.topicSpaceName);
      expect(binding.clientGroup).toEqual(clientGroup.clientGroupName);
      const observed = yield* getBinding(
        group.resourceGroupName,
        namespace.namespaceName,
        binding.permissionBindingName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.permission).toEqual("Publisher");

      // In place: permission and description.
      const updated = yield* stack.deploy(
        program({ permission: "Subscriber", description: "read telemetry" }),
      );
      expect(updated.binding.permissionBindingName).toEqual(
        binding.permissionBindingName,
      );
      expect(updated.binding.description).toEqual("read telemetry");
      const reobserved = yield* getBinding(
        group.resourceGroupName,
        namespace.namespaceName,
        binding.permissionBindingName,
      );
      expect(reobserved.properties?.permission).toEqual("Subscriber");

      // Renaming replaces the binding.
      const renamed = yield* stack.deploy(
        program({ permission: "Subscriber", name: "sensors-subscribe" }),
      );
      expect(renamed.binding.permissionBindingName).toEqual(
        "sensors-subscribe",
      );
      expect(
        yield* bindingGone(
          group.resourceGroupName,
          namespace.namespaceName,
          binding.permissionBindingName,
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* bindingGone(
          group.resourceGroupName,
          namespace.namespaceName,
          "sensors-subscribe",
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:eventgrid", "live"],
    timeout: 600_000,
  },
);
