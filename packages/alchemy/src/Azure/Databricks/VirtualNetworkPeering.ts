import * as databricks from "@distilled.cloud/azure/databricks";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  stackAndStage,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface VirtualNetworkPeeringProps {
  /**
   * Resource group of the Databricks workspace. Changing it replaces the
   * peering.
   */
  resourceGroup: string;
  /**
   * Name of the Databricks workspace whose managed VNet is peered. The
   * workspace must not use VNet injection. Changing it replaces the peering.
   */
  workspace: string;
  /**
   * Name of the peering. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the peering.
   */
  name?: string;
  /**
   * ARM ID of the remote virtual network (same region as the workspace).
   * Changing it replaces the peering.
   */
  remoteVirtualNetworkId: string;
  /**
   * Address prefixes of the remote virtual network. Changing them replaces
   * the peering.
   * @default resolved by Azure from the remote VNet
   */
  remoteAddressPrefixes?: string[];
  /**
   * Whether VMs in the Databricks VNet can reach VMs in the remote VNet.
   * @default true
   */
  allowVirtualNetworkAccess?: boolean;
  /**
   * Whether forwarded traffic from the Databricks VNet is allowed into the
   * remote VNet.
   * @default false
   */
  allowForwardedTraffic?: boolean;
  /**
   * Whether gateway links can be used in the remote VNet to link to the
   * Databricks VNet.
   * @default false
   */
  allowGatewayTransit?: boolean;
  /**
   * Whether the Databricks VNet uses the remote VNet's gateways.
   * @default false
   */
  useRemoteGateways?: boolean;
}

export interface VirtualNetworkPeering extends Resource<
  "Azure.Databricks.VirtualNetworkPeering",
  VirtualNetworkPeeringProps,
  {
    /** Name of the peering. */
    peeringName: string;
    /** ARM resource ID of the peering. */
    peeringId: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Name of the workspace. */
    workspace: string;
    /** ARM ID of the remote virtual network. */
    remoteVirtualNetworkId: string;
    /**
     * ARM ID of the workspace's managed (Databricks) virtual network. Use it
     * as the `remoteVirtualNetworkId` of the reverse
     * `Azure.Network.VirtualNetworkPeering`.
     */
    databricksVirtualNetworkId: string;
    /** Address prefixes of the Databricks virtual network. */
    databricksAddressPrefixes: string[];
    /**
     * Peering state: `Initiated` until the reverse peering exists, then
     * `Connected`.
     */
    peeringState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A virtual network peering from an Azure Databricks workspace's managed
 * VNet to another virtual network in the same region. Peering only connects
 * once the remote VNet has the reverse `Azure.Network.VirtualNetworkPeering`
 * pointing at `databricksVirtualNetworkId`. Only workspaces that do not use
 * VNet injection can be peered this way.
 *
 * @see https://learn.microsoft.com/azure/databricks/security/network/classic/vnet-peering
 *
 * ### Peering a Workspace
 * **Example:** Peer the workspace VNet with a hub VNet, both directions
 * ```typescript
 * const hub = yield* Azure.Network.VirtualNetwork("hub", {
 *   resourceGroup: group.resourceGroupName,
 *   addressPrefixes: ["10.20.0.0/16"],
 * });
 * const toHub = yield* Azure.Databricks.VirtualNetworkPeering("to-hub", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   remoteVirtualNetworkId: hub.virtualNetworkId,
 * });
 * yield* Azure.Network.VirtualNetworkPeering("hub-to-databricks", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualNetwork: hub.virtualNetworkName,
 *   remoteVirtualNetworkId: toHub.databricksVirtualNetworkId,
 * });
 * ```
 *
 * @resource
 */
export const VirtualNetworkPeering = Resource<VirtualNetworkPeering>(
  "Azure.Databricks.VirtualNetworkPeering",
);

type Observed = databricks.GetVNetPeeringResponse;

const getPeering = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  peeringName: string,
) =>
  orUndefinedIfNotFound(
    databricks.GetVNetPeering({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      peeringName,
    }),
  );

const createName = (id: string) => createPhysicalName({ id, maxLength: 80 });

const lower = (value: string | undefined) => value?.toLowerCase();

/** The parent workspace rejects writes while it provisions or updates. */
const whileApplianceBusy = {
  while: (e: { readonly _tag: string }) => e._tag === "DatabricksApplianceBusy",
  schedule: Schedule.spaced("10 seconds"),
  times: 30,
} as const;

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  name: string,
  peering: Observed,
): VirtualNetworkPeering["Attributes"] => ({
  peeringName: name,
  peeringId: peering.id ?? "",
  resourceGroup,
  workspace,
  remoteVirtualNetworkId: peering.properties.remoteVirtualNetwork.id ?? "",
  databricksVirtualNetworkId:
    peering.properties.databricksVirtualNetwork?.id ?? "",
  databricksAddressPrefixes: [
    ...(peering.properties.databricksAddressSpace?.addressPrefixes ?? []),
  ],
  peeringState: peering.properties.peeringState,
});

export const VirtualNetworkPeeringProvider = () =>
  Provider.succeed(VirtualNetworkPeering, {
    stables: [
      "peeringName",
      "peeringId",
      "resourceGroup",
      "workspace",
      "remoteVirtualNetworkId",
      "databricksVirtualNetworkId",
    ],

    // Peerings live inside a workspace and are deleted with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.workspace) !== lower(output.workspace) ||
        lower(news.remoteVirtualNetworkId) !==
          lower(output.remoteVirtualNetworkId) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.peeringName)) ||
        (olds !== undefined &&
          !sameSet(
            news.remoteAddressPrefixes ?? [],
            olds.remoteAddressPrefixes ?? [],
          ))
      ) {
        // A VNet holds one peering per remote VNet: delete the old first.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspace ?? olds?.workspace;
      if (resourceGroup === undefined || workspace === undefined) {
        return undefined;
      }
      const name = output?.peeringName ?? olds?.name ?? (yield* createName(id));
      const observed = yield* getPeering(
        subscriptionId,
        resourceGroup,
        workspace,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, name, observed);
      // Peerings carry no tags: ownership follows the parent workspace.
      const parent = yield* orUndefinedIfNotFound(
        databricks.GetWorkspace({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workspaceName: workspace,
        }),
      );
      const { stack, stage } = yield* stackAndStage;
      return parent?.tags?.["alchemy::stack"] === stack &&
        parent.tags["alchemy::stage"] === stage
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Databricks");
      const { resourceGroup, workspace } = news;
      const name = news.name ?? output?.peeringName ?? (yield* createName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        workspaceName: workspace,
        peeringName: name,
      };
      const label = `Databricks peering ${workspace}/${name}`;
      const get = getPeering(subscriptionId, resourceGroup, workspace, name);
      const wait = waitForProvisioned(
        label,
        get,
        (peering) => peering.properties.provisioningState,
        { interval: "5 seconds", times: 60 },
      );
      const desired = {
        allowVirtualNetworkAccess: news.allowVirtualNetworkAccess ?? true,
        allowForwardedTraffic: news.allowForwardedTraffic ?? false,
        allowGatewayTransit: news.allowGatewayTransit ?? false,
        useRemoteGateways: news.useRemoteGateways ?? false,
      };

      // Observe.
      let observed = yield* get;

      // A peering pointing at another remote VNet, or disconnected because
      // the reverse side was deleted, cannot be fixed in place.
      if (
        observed !== undefined &&
        (observed.properties.peeringState === "Disconnected" ||
          lower(observed.properties.remoteVirtualNetwork.id) !==
            lower(news.remoteVirtualNetworkId))
      ) {
        yield* ignoreNotFound(
          databricks
            .DeleteVNetPeering(where)
            .pipe(Effect.retry(whileApplianceBusy)),
        );
        yield* waitUntilGone(label, get, { interval: "5 seconds", times: 60 });
        observed = undefined;
      }

      // Ensure + sync: one PUT when missing or a flag drifts.
      const p = observed?.properties;
      if (
        observed === undefined ||
        (p?.allowVirtualNetworkAccess ?? true) !==
          desired.allowVirtualNetworkAccess ||
        (p?.allowForwardedTraffic ?? false) !== desired.allowForwardedTraffic ||
        (p?.allowGatewayTransit ?? false) !== desired.allowGatewayTransit ||
        (p?.useRemoteGateways ?? false) !== desired.useRemoteGateways
      ) {
        yield* databricks
          .VNetPeeringCreateOrUpdate({
            ...where,
            properties: {
              ...desired,
              remoteVirtualNetwork: { id: news.remoteVirtualNetworkId },
              remoteAddressSpace:
                news.remoteAddressPrefixes !== undefined
                  ? { addressPrefixes: news.remoteAddressPrefixes }
                  : p?.remoteAddressSpace,
              databricksVirtualNetwork: p?.databricksVirtualNetwork,
              databricksAddressSpace: p?.databricksAddressSpace,
            },
          })
          .pipe(Effect.retry(whileApplianceBusy));
      }
      observed = yield* wait;

      return toAttrs(resourceGroup, workspace, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        databricks
          .DeleteVNetPeering({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            workspaceName: output.workspace,
            peeringName: output.peeringName,
          })
          .pipe(Effect.retry(whileApplianceBusy)),
      );
      yield* waitUntilGone(
        `Databricks peering ${output.workspace}/${output.peeringName}`,
        getPeering(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.peeringName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.Databricks.Workspace",
      ],
    },
  });
