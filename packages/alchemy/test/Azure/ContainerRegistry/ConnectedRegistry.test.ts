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
    const gatewayActions = [
      "gateway/edgegateway/config/read",
      "gateway/edgegateway/config/write",
      "gateway/edgegateway/message/read",
      "gateway/edgegateway/message/write",
    ];
    const readActions = [
      "repositories/hello-world/content/read",
      "repositories/hello-world/metadata/read",
    ];
    // Azure requires a ReadOnly connected registry's sync scope map to lack
    // repository write actions and a ReadWrite one's to have them, so each
    // mode gets its own scope map + token. Both stay deployed across the
    // mode replacement.
    const readOnlyScope = yield* Azure.ContainerRegistry.ScopeMap(
      "SyncScope",
      {
        resourceGroup: group.resourceGroupName,
        registry: registry.registryName,
        actions: [...readActions, ...gatewayActions],
      },
    );
    const readWriteScope = yield* Azure.ContainerRegistry.ScopeMap(
      "SyncScopeReadWrite",
      {
        resourceGroup: group.resourceGroupName,
        registry: registry.registryName,
        actions: [
          ...readActions,
          "repositories/hello-world/content/write",
          "repositories/hello-world/content/delete",
          "repositories/hello-world/metadata/write",
          ...gatewayActions,
        ],
      },
    );
    const readOnlyToken = yield* Azure.ContainerRegistry.Token("SyncToken", {
      resourceGroup: group.resourceGroupName,
      registry: registry.registryName,
      scopeMapId: readOnlyScope.scopeMapId,
    });
    const readWriteToken = yield* Azure.ContainerRegistry.Token(
      "SyncTokenReadWrite",
      {
        resourceGroup: group.resourceGroupName,
        registry: registry.registryName,
        scopeMapId: readWriteScope.scopeMapId,
      },
    );
    const syncToken =
      props.mode === "ReadWrite" ? readWriteToken : readOnlyToken;
    const connected = yield* Azure.ContainerRegistry.ConnectedRegistry("Edge", {
      resourceGroup: group.resourceGroupName,
      registry: registry.registryName,
      name: "edgegateway",
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
          "edgegateway",
        );
      const observed = yield* get();
      expect(observed.properties?.mode).toEqual("ReadOnly");
      expect(
        observed.properties?.parent?.syncProperties?.tokenId?.toLowerCase(),
      ).toEqual(syncToken.tokenId.toLowerCase());
      expect(observed.properties?.connectionState).toEqual("Offline");
      expect(connected.connectedRegistryName).toEqual("edgegateway");

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
