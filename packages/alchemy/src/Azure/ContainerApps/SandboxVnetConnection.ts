import * as app from "@distilled.cloud/azure/app";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createContainerAppsName, lower, taggedByStack } from "./common.ts";

export interface SandboxVnetConnectionProps {
  /** Resource group of the sandbox group. Changing it replaces the connection. */
  resourceGroup: string;
  /** Name of the sandbox group. Changing it replaces the connection. */
  sandboxGroup: string;
  /**
   * Connection name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the connection.
   */
  name?: string;
  /**
   * ARM ID of the subnet the group's sandboxes join. The subnet must be
   * delegated to `Microsoft.App/environments`. Changing it replaces the
   * connection.
   */
  subnetId: string;
}

export interface SandboxVnetConnection extends Resource<
  "Azure.ContainerApps.SandboxVnetConnection",
  SandboxVnetConnectionProps,
  {
    /** Name of the connection. */
    connectionName: string;
    /** ARM resource ID of the connection. */
    connectionId: string;
    /** Name of the sandbox group. */
    sandboxGroup: string;
    /** Resource group of the sandbox group. */
    resourceGroup: string;
    /** ARM ID of the connected subnet. */
    subnetId: string;
  },
  never,
  Providers
> {}

/**
 * A virtual network connection of a sandbox group
 * (`Microsoft.App/sandboxGroups/vnetConnections`) — places the group's
 * sandboxes in a subnet so they can reach private resources. The subnet must
 * be delegated to `Microsoft.App/environments`.
 *
 * Connections cannot be tagged; Alchemy treats a connection as owned when
 * its sandbox group is owned by the same stack and stage.
 *
 * ### Connecting Sandboxes to a VNet
 * **Example:** Sandboxes in a private subnet
 * ```typescript
 * const subnet = yield* Azure.Network.Subnet("sandboxes", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.40.1.0/24",
 *   delegations: [{ serviceName: "Microsoft.App/environments" }],
 * });
 * const sandboxes = yield* Azure.ContainerApps.SandboxGroup("sandboxes", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.ContainerApps.SandboxVnetConnection("private", {
 *   resourceGroup: group.resourceGroupName,
 *   sandboxGroup: sandboxes.sandboxGroupName,
 *   subnetId: subnet.subnetId,
 * });
 * ```
 *
 * @resource
 */
export const SandboxVnetConnection = Resource<SandboxVnetConnection>(
  "Azure.ContainerApps.SandboxVnetConnection",
);

const createConnectionName = (id: string) => createContainerAppsName(id, 32);

const getConnection = (
  subscriptionId: string,
  resourceGroupName: string,
  sandboxGroupName: string,
  vnetConnectionName: string,
) =>
  orUndefinedIfNotFound(
    app.GetVnetConnection({
      subscriptionId,
      resourceGroupName,
      sandboxGroupName,
      vnetConnectionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  sandboxGroup: string,
  name: string,
  observed: app.GetVnetConnectionResponse,
): SandboxVnetConnection["Attributes"] => ({
  connectionName: name,
  connectionId: observed.id ?? "",
  sandboxGroup,
  resourceGroup,
  subnetId: observed.properties?.subnetId ?? "",
});

/** Whether the sandbox group is tagged as owned by the current stack. */
const isGroupOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  sandboxGroupName: string,
) {
  const group = yield* orUndefinedIfNotFound(
    app.GetSandboxGroup({
      subscriptionId,
      resourceGroupName,
      sandboxGroupName,
    }),
  );
  return group !== undefined && (yield* taggedByStack(group.tags));
});

export const SandboxVnetConnectionProvider = () =>
  Provider.succeed(SandboxVnetConnection, {
    stables: [
      "connectionName",
      "connectionId",
      "sandboxGroup",
      "resourceGroup",
    ],

    // Lives inside a sandbox group; nuke removes it with the group.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        news.sandboxGroup !== output.sandboxGroup ||
        (news.name !== undefined && news.name !== output.connectionName) ||
        lower(news.subnetId) !== lower(output.subnetId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const sandboxGroup = output?.sandboxGroup ?? olds?.sandboxGroup;
      if (resourceGroup === undefined || sandboxGroup === undefined) {
        return undefined;
      }
      const name =
        output?.connectionName ??
        olds?.name ??
        (yield* createConnectionName(id));
      const observed = yield* getConnection(
        subscriptionId,
        resourceGroup,
        sandboxGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, sandboxGroup, name, observed);
      return (yield* isGroupOwnedByStack(
        subscriptionId,
        resourceGroup,
        sandboxGroup,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.App");
      const { resourceGroup, sandboxGroup } = news;
      const name =
        news.name ??
        output?.connectionName ??
        (yield* createConnectionName(id));
      const get = getConnection(
        subscriptionId,
        resourceGroup,
        sandboxGroup,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure. The subnet is the connection's identity; nothing else is
      // mutable.
      if (observed === undefined) {
        // The connection must live in its sandbox group's region.
        const group = yield* app.GetSandboxGroup({
          subscriptionId,
          resourceGroupName: resourceGroup,
          sandboxGroupName: sandboxGroup,
        });
        yield* app.VnetConnectionsCreateOrUpdate({
          location: group.location,
          subscriptionId,
          resourceGroupName: resourceGroup,
          sandboxGroupName: sandboxGroup,
          vnetConnectionName: name,
          properties: { subnetId: news.subnetId },
        });
      }

      const fresh = yield* waitForProvisioned(
        `sandbox vnet connection ${name}`,
        get,
        (connection) => connection.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, sandboxGroup, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        app.DeleteVnetConnection({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          sandboxGroupName: output.sandboxGroup,
          vnetConnectionName: output.connectionName,
        }),
      );
      yield* waitUntilGone(
        `sandbox vnet connection ${output.connectionName}`,
        getConnection(
          subscriptionId,
          output.resourceGroup,
          output.sandboxGroup,
          output.connectionName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
