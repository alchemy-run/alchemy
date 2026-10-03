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

const getNamespace = (resourceGroupName: string, namespaceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* eventgrid.GetNamespace({
      subscriptionId,
      resourceGroupName,
      namespaceName,
    });
  });

const namespaceGone = (resourceGroupName: string, namespaceName: string) =>
  getNamespace(resourceGroupName, namespaceName).pipe(
    Effect.map((namespace) =>
      namespace.properties?.provisioningState === "Deleted"
        ? ("gone" as const)
        : ("found" as const),
    ),
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
  capacity: number;
  mqtt: boolean;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const namespace = yield* Azure.EventGrid.Namespace("Events", {
      resourceGroup: group.resourceGroupName,
      capacity: props.capacity,
      topicSpacesConfiguration: props.mqtt ? { state: "Enabled" } : undefined,
      tags: props.tags,
    });
    return { group, namespace };
  });

// Standard namespace billed per throughput-unit hour; 1-2 TUs for ~10
// minutes costs well under $0.10.
test.provider(
  "create, update, and delete an event grid namespace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, namespace } = yield* stack.deploy(
        program({ capacity: 1, mqtt: false, tags: { env: "test" } }),
      );
      expect(namespace.namespaceName).toMatch(/^[A-Za-z0-9-]{3,50}$/);
      expect(namespace.capacity).toEqual(1);
      expect(namespace.topicSpacesEnabled).toEqual(false);
      expect(namespace.topicsHostname).toContain(".eventgrid.azure.net");
      expect(namespace.primaryKey).toBeDefined();
      const observed = yield* getNamespace(
        group.resourceGroupName,
        namespace.namespaceName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.sku?.capacity).toEqual(1);
      expect(observed.tags?.env).toEqual("test");

      // In-place: capacity, tags, and enabling the MQTT broker.
      const updated = yield* stack.deploy(
        program({ capacity: 2, mqtt: true, tags: { env: "prod" } }),
      );
      expect(updated.namespace.namespaceName).toEqual(namespace.namespaceName);
      expect(updated.namespace.topicSpacesEnabled).toEqual(true);
      expect(updated.namespace.topicSpacesHostname).toBeDefined();
      const reobserved = yield* getNamespace(
        group.resourceGroupName,
        namespace.namespaceName,
      );
      expect(reobserved.sku?.capacity).toEqual(2);
      expect(reobserved.properties?.topicSpacesConfiguration?.state).toEqual(
        "Enabled",
      );
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* namespaceGone(group.resourceGroupName, namespace.namespaceName),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:eventgrid", "live"],
    timeout: 600_000,
  },
);
