import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { sameName } from "./Common.ts";

export type WorkspaceGatewaySkuName =
  apim.ApiManagementGatewaySkuPropertiesName;

export interface WorkspaceGatewayProps {
  /** Resource group the gateway is created in. Changing it replaces the gateway. */
  resourceGroup: string;
  /**
   * Gateway name, unique within the resource group. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the gateway.
   */
  name?: string;
  /**
   * Azure location of the gateway. Changing it replaces the gateway.
   * @default the `Azure.Location` layer, else the profile location
   */
  location?: string;
  /**
   * Gateway SKU, e.g. `WorkspaceGatewayPremium`. Changing it replaces the
   * gateway.
   * @default "WorkspaceGatewayPremium"
   */
  sku?: WorkspaceGatewaySkuName;
  /**
   * Number of scale units.
   * @default 1
   */
  capacity?: number;
  /**
   * Virtual network integration: `None`, `External` (public frontend,
   * backend in a subnet), or `Internal`.
   * @default "None"
   */
  virtualNetworkType?: "None" | "External" | "Internal";
  /** ARM ID of the subnet the gateway reaches backends through (`External`/`Internal`). */
  backendSubnetId?: string;
  /** User tags. */
  tags?: Record<string, string>;
}

export interface WorkspaceGateway extends Resource<
  "Azure.ApiManagement.WorkspaceGateway",
  WorkspaceGatewayProps,
  {
    /** Gateway name. */
    gatewayName: string;
    /** ARM resource ID of the gateway. */
    gatewayId: string;
    /** Resource group of the gateway. */
    resourceGroup: string;
    /** Azure location of the gateway. */
    location: string;
    /** Gateway SKU name. */
    sku: string;
    /** Number of scale units. */
    capacity: number;
    /** Default hostname of the gateway's runtime endpoint. */
    defaultHostname: string | undefined;
    /** Hostname of the gateway's configuration API. */
    configurationApiHostname: string | undefined;
    /** User tags. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A standalone workspace gateway (`Microsoft.ApiManagement/gateways`): a
 * dedicated, independently scaled runtime for the APIs of one or more API
 * Management {@link Workspace}s, attached with
 * {@link WorkspaceGatewayConfigConnection}. Requires a Premium service;
 * creation takes 30+ minutes and the gateway bills per scale unit.
 *
 * @see https://learn.microsoft.com/azure/api-management/workspaces-overview#workspace-gateway
 *
 * ### Creating a Workspace Gateway
 * **Example:** A premium workspace gateway
 * ```typescript
 * const gateway = yield* Azure.ApiManagement.WorkspaceGateway("payments-gw", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "WorkspaceGatewayPremium",
 *   capacity: 1,
 * });
 * yield* Azure.ApiManagement.WorkspaceGatewayConfigConnection("payments", {
 *   resourceGroup: group.resourceGroupName,
 *   gatewayName: gateway.gatewayName,
 *   workspaceId: workspace.workspaceId,
 * });
 * ```
 *
 * @resource
 */
export const WorkspaceGateway = Resource<WorkspaceGateway>(
  "Azure.ApiManagement.WorkspaceGateway",
);

const createGatewayName = (id: string) =>
  createPhysicalName({ id, maxLength: 45, lowercase: true });

const getGateway = (
  subscriptionId: string,
  resourceGroupName: string,
  gatewayName: string,
) =>
  orUndefinedIfNotFound(
    apim.GetApiGateway({ subscriptionId, resourceGroupName, gatewayName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  gateway: apim.GetApiGatewayResponse,
): WorkspaceGateway["Attributes"] => ({
  gatewayName: name,
  gatewayId: gateway.id ?? "",
  resourceGroup,
  location: gateway.location,
  sku: gateway.sku.name,
  capacity: gateway.sku.capacity ?? 1,
  defaultHostname: gateway.properties.frontend?.defaultHostname,
  configurationApiHostname: gateway.properties.configurationApi?.hostname,
  tags: userTags(gateway.tags),
});

const label = (name: string) => `API Management workspace gateway ${name}`;

// Workspace gateways take 30+ minutes to provision.
const budget = { interval: "60 seconds", times: 60 } as const;

export const WorkspaceGatewayProvider = () =>
  Provider.succeed(WorkspaceGateway, {
    stables: ["gatewayName", "gatewayId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* apim
        .ListApiGateway({ subscriptionId })
        .pipe(
          Effect.flatMap((page) => requireSinglePage("ListApiGateway", page)),
        );
      return (page.value ?? []).flatMap((gateway) => {
        const group = resourceGroupOf(gateway.id);
        return hasAnyAlchemyTag(gateway.tags) &&
          group !== undefined &&
          gateway.name !== undefined
          ? [toAttrs(group, gateway.name, gateway)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameName(news.name, output.gatewayName)) ||
        (news.location !== undefined &&
          !sameName(
            news.location.replaceAll(" ", ""),
            output.location.replaceAll(" ", ""),
          )) ||
        (news.sku ?? "WorkspaceGatewayPremium") !== output.sku
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.gatewayName ?? olds?.name ?? (yield* createGatewayName(id));
      const observed = yield* getGateway(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.ApiManagement");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.gatewayName ?? (yield* createGatewayName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const sku = {
        name: news.sku ?? "WorkspaceGatewayPremium",
        capacity: news.capacity ?? 1,
      };
      const virtualNetworkType = news.virtualNetworkType ?? "None";
      const backend =
        news.backendSubnetId === undefined
          ? undefined
          : { subnet: { id: news.backendSubnetId } };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        gatewayName: name,
      };
      const get = getGateway(subscriptionId, resourceGroup, name);

      // Observe, then ensure.
      let observed = yield* get;
      if (observed === undefined) {
        yield* apim.ApiGatewayCreateOrUpdate({
          ...where,
          location,
          sku,
          tags,
          properties: { virtualNetworkType, backend },
        });
      }
      observed = yield* waitForProvisioned(
        label(name),
        get,
        (gateway) => gateway.properties.provisioningState,
        budget,
      );

      // Sync capacity, network, and tags against observed state.
      const capacityChanged = (observed.sku.capacity ?? 1) !== sku.capacity;
      const networkChanged =
        (observed.properties.virtualNetworkType ?? "None") !==
          virtualNetworkType ||
        (news.backendSubnetId !== undefined &&
          !sameName(
            observed.properties.backend?.subnet?.id,
            news.backendSubnetId,
          ));
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (capacityChanged || networkChanged || tagsChanged) {
        yield* apim.UpdateApiGateway({
          ...where,
          sku: capacityChanged ? sku : undefined,
          tags: tagsChanged ? tags : undefined,
          properties: networkChanged
            ? { virtualNetworkType, backend }
            : undefined,
        });
        observed = yield* waitForProvisioned(
          label(name),
          get,
          (gateway) => gateway.properties.provisioningState,
          budget,
        );
      }
      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        apim.DeleteApiGateway({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          gatewayName: output.gatewayName,
        }),
      );
      yield* waitUntilGone(
        label(output.gatewayName),
        getGateway(subscriptionId, output.resourceGroup, output.gatewayName),
        { interval: "30 seconds", times: 90 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
