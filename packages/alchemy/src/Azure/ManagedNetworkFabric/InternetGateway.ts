import * as mnf from "@distilled.cloud/azure/managednetworkfabric";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
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
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createFabricName,
  differs,
  FABRIC_NAMESPACE,
  propertyDelta,
  sameArm,
  waitFabricProvisioned,
} from "./Common.ts";

export interface InternetGatewayProps {
  /**
   * Resource group the internet gateway is created in. Changing it replaces
   * the internet gateway.
   */
  resourceGroup: string;
  /**
   * Name of the internet gateway. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the internet gateway.
   */
  name?: string;
  /**
   * Azure location of the internet gateway. Changing it replaces the internet
   * gateway. Network Fabric resources are offered in `eastus`,
   * `southcentralus`, `westus3`, `australiaeast`, `uaenorth`, `uksouth`, and
   * `northeurope`.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the Network Fabric Controller that hosts the gateway. Changing
   * it replaces the internet gateway.
   */
  networkFabricControllerId: string;
  /**
   * Gateway type: `Infrastructure` (Operator Nexus infrastructure egress) or
   * `Workload` (tenant workload egress). Changing it replaces the internet
   * gateway.
   */
  type: mnf.GatewayType;
  /**
   * ARM ID of the internet gateway rule (allow-list of egress addresses)
   * applied to the gateway.
   */
  internetGatewayRuleId?: string;
  /** Free-form description. Changing it replaces the internet gateway. */
  annotation?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface InternetGateway extends Resource<
  "Azure.ManagedNetworkFabric.InternetGateway",
  InternetGatewayProps,
  {
    /** Name of the internet gateway. */
    internetGatewayName: string;
    /** ARM resource ID of the internet gateway. */
    internetGatewayId: string;
    /** Resource group that holds the internet gateway. */
    resourceGroup: string;
    /** Location of the internet gateway. */
    location: string;
    /** Gateway type, `Infrastructure` or `Workload`. */
    type: string | undefined;
    /** ARM ID of the applied internet gateway rule. */
    internetGatewayRuleId: string | undefined;
    /** IPv4 address of the internet gateway proxy. */
    ipv4Address: string | undefined;
    /** Port of the internet gateway proxy. */
    port: number | undefined;
    /** Provisioning state, e.g. `Succeeded`. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Operator Nexus internet gateway — an egress proxy hosted on a
 * Network Fabric Controller that lets Nexus infrastructure or tenant
 * workloads reach the internet through an allow-list
 * (`InternetGatewayRule`).
 *
 * The resource provider creates internet gateways itself when a Network
 * Fabric Controller is created and rejects a user PUT (`InternetGateways PUT
 * not allowed`). Manage an existing gateway by passing its `name` and
 * adopting it; Alchemy then syncs the applied rule and tags, and deleting
 * the resource deletes the gateway.
 *
 * @see https://learn.microsoft.com/rest/api/managednetworkfabric/internet-gateways
 *
 * ### Managing an Internet Gateway
 * **Example:** Attach an allow-list rule to the controller's gateway
 * ```typescript
 * const rule = yield* Azure.ManagedNetworkFabric.InternetGatewayRule("allow", {
 *   resourceGroup: "nexus",
 *   ruleProperties: {
 *     action: "Allow",
 *     addressList: ["10.10.10.10"],
 *   },
 * });
 * const gateway = yield* Azure.ManagedNetworkFabric.InternetGateway("egress", {
 *   resourceGroup: "nexus",
 *   name: "nfc1-workload-igw",
 *   networkFabricControllerId:
 *     "/subscriptions/.../resourceGroups/nexus/providers/Microsoft.ManagedNetworkFabric/networkFabricControllers/nfc1",
 *   type: "Workload",
 *   internetGatewayRuleId: rule.internetGatewayRuleId,
 * }).pipe(AdoptPolicy.adopt());
 * ```
 *
 * @resource
 */
export const InternetGateway = Resource<InternetGateway>(
  "Azure.ManagedNetworkFabric.InternetGateway",
);

type Observed = mnf.GetInternetGatewayResponse;

const getInternetGateway = (
  subscriptionId: string,
  resourceGroupName: string,
  internetGatewayName: string,
) =>
  orUndefinedIfNotFound(
    mnf.GetInternetGateway({
      subscriptionId,
      resourceGroupName,
      internetGatewayName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed,
): InternetGateway["Attributes"] => {
  const p = observed.properties;
  return {
    internetGatewayName: name,
    internetGatewayId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    type: p?.type ?? p?.internetGatewayType,
    internetGatewayRuleId: p?.internetGatewayRuleId,
    ipv4Address: p?.ipv4Address,
    port: p?.port,
    provisioningState: p?.provisioningState,
    tags: userTags(observed.tags),
  };
};

export const InternetGatewayProvider = () =>
  Provider.succeed(InternetGateway, {
    stables: [
      "internetGatewayName",
      "internetGatewayId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* mnf
        .ListInternetGatewayBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListInternetGatewayBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((item) => {
        const group = resourceGroupOf(item.id);
        return hasAnyAlchemyTag(item.tags) &&
          group !== undefined &&
          item.name !== undefined
          ? [toAttrs(group, item.name, item)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.internetGatewayName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        (olds !== undefined &&
          (!sameArm(
            news.networkFabricControllerId,
            olds.networkFabricControllerId,
          ) ||
            !sameArm(news.type, olds.type) ||
            differs(news.annotation, olds.annotation)))
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
        output?.internetGatewayName ??
        olds?.name ??
        (yield* createFabricName(id));
      const observed = yield* getInternetGateway(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, FABRIC_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.internetGatewayName ??
        (yield* createFabricName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        internetGatewayName: name,
      };
      const label = `internet gateway ${name}`;
      const get = getInternetGateway(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* mnf.CreateInternetGateway({
          ...where,
          location,
          tags,
          properties: {
            networkFabricControllerId: news.networkFabricControllerId,
            type: news.type,
            internetGatewayRuleId: news.internetGatewayRuleId,
            annotation: news.annotation,
          },
        });
      }
      observed = yield* waitFabricProvisioned(label, get);

      // Sync mutable aspects against observed state; send only the delta.
      const delta = propertyDelta(observed.properties, {
        internetGatewayRuleId: news.internetGatewayRuleId,
      });
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (delta !== undefined || tagsChanged) {
        yield* mnf.UpdateInternetGateway({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: delta,
        });
        observed = yield* waitFabricProvisioned(label, get);
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const label = `internet gateway ${output.internetGatewayName}`;
      const get = getInternetGateway(
        subscriptionId,
        output.resourceGroup,
        output.internetGatewayName,
      );
      yield* ignoreNotFound(
        mnf.DeleteInternetGateway({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          internetGatewayName: output.internetGatewayName,
        }),
      );
      yield* waitUntilGone(label, get, { interval: "5 seconds", times: 60 });
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.ManagedNetworkFabric.InternetGatewayRule",
        "Azure.ManagedNetworkFabric.NetworkFabricController",
      ],
    },
  });
