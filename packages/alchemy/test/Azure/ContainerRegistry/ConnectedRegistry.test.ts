import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as containerregistry from "@distilled.cloud/azure/containerregistry";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { getRegistry, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConnectedRegistry = (
  resourceGroupName: string,
  registryName: string,
  connectedRegistryName: string,
) =>
  Effect.gen(function* () {
    return yield* containerregistry.GetConnectedRegistry({
      subscriptionId: yield* subscription,
      resourceGroupName,
      registryName,
      connectedRegistryName,
    });
  });

const program = (props: {
  mode: Azure.ContainerRegistry.ConnectedRegistryMode;
  logLevel: "Information" | "Debug";
  notifications: string[];
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const registry = yield* Azure.ContainerRegistry.Registry("Registry", {
      resourceGroup: group.resourceGroupName,
      sku: "Premium",
      dataEndpointEnabled: true,
    });
    const syncScope = yield* Azure.ContainerRegistry.ScopeMap("SyncScope", {
      resourceGroup: group.resourceGroupName,
      registry: registry.registryName,
      actions: [
        "repositories/hello-world/content/read",
        "repositories/hello-world/metadata/read",
        "gateway/edge/config/read",
        "gateway/edge/config/write",
        "gateway/edge/message/read",
        "gateway/edge/message/write",
      ],
    });
    const syncToken = yield* Azure.ContainerRegistry.Token("SyncToken", {
      resourceGroup: group.resourceGroupName,
      registry: registry.registryName,
      scopeMapId: syncScope.scopeMapId,
    });
    const connected = yield* Azure.ContainerRegistry.ConnectedRegistry("Edge", {
      resourceGroup: group.resourceGroupName,
      registry: registry.registryName,
      name: "edge",
      mode: props.mode,
      syncTokenId: syncToken.tokenId,
      logging: { logLevel: props.logLevel },
      notificationsList: props.notifications,
    });
    return { group, registry, syncToken, connected };
  });

// Premium registry with data endpoints (~$1.67/day) plus a connected
// registry (~$10/month, billed per day): ~$2-3 per run, a few minutes.
test.provider.skipIf(!runExpensive)(
  "create, update, replace, and delete a connected registry",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, registry, syncToken, connected } = yield* stack.deploy(
        program({
          mode: "ReadOnly",
          logLevel: "Information",
          notifications: ["hello-world:*:push"],
        }),
      );
      const get = () =>
        getConnectedRegistry(
          group.resourceGroupName,
          registry.registryName,
          "edge",
        );
      const observed = yield* get();
      expect(observed.properties?.mode).toEqual("ReadOnly");
      expect(
        observed.properties?.parent?.syncProperties?.tokenId?.toLowerCase(),
      ).toEqual(syncToken.tokenId.toLowerCase());
      expect(observed.properties?.connectionState).toEqual("Offline");
      expect(connected.connectedRegistryName).toEqual("edge");

      // In-place: logging and notifications.
      const updated = yield* stack.deploy(
        program({
          mode: "ReadOnly",
          logLevel: "Debug",
          notifications: ["hello-world:*:push", "hello-world:*:delete"],
        }),
      );
      expect(updated.connected.connectedRegistryId).toEqual(
        connected.connectedRegistryId,
      );
      const reobserved = yield* get();
      expect(reobserved.properties?.logging?.logLevel).toEqual("Debug");
      expect(
        [...(reobserved.properties?.notificationsList ?? [])].sort(),
      ).toEqual(["hello-world:*:delete", "hello-world:*:push"]);

      // Replacement: the mode is immutable (same name: delete-then-create).
      const replaced = yield* stack.deploy(
        program({
          mode: "ReadWrite",
          logLevel: "Debug",
          notifications: ["hello-world:*:push"],
        }),
      );
      expect(replaced.connected.mode).toEqual("ReadWrite");
      const replacedObserved = yield* get();
      expect(replacedObserved.properties?.mode).toEqual("ReadWrite");

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
      expect(
        yield* waitGone(
          getRegistry(group.resourceGroupName, registry.registryName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
