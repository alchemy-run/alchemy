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

export interface AccessControlListProps {
  /**
   * Resource group the access control list is created in. Changing it replaces the
   * access control list.
   */
  resourceGroup: string;
  /**
   * Name of the access control list. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the access control list.
   */
  name?: string;
  /**
   * Azure location of the access control list. Changing it replaces the access control list.
   * Network Fabric resources are offered in `eastus`, `southcentralus`,
   * `westus3`, `australiaeast`, `uaenorth`, `uksouth`, and `northeurope`.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * `Inline` (rules in `matchConfigurations`) or `File` (rules at `aclsUrl`).
   * Changing it replaces the ACL.
   */
  configurationType: mnf.AccessControlListPropertiesInput["configurationType"];
  /**
   * ACL kind, e.g. `Tenant` or `ControlPlaneTrafficPolicy`. Changing it
   * replaces the ACL.
   */
  aclType?: mnf.AccessControlListPropertiesInput["aclType"];
  /**
   * Device role the ACL applies to (`CE`, `ToR`, `NPB`,
   * `ManagementSwitch`). Changing it replaces the ACL.
   */
  deviceRole?: mnf.AccessControlListPropertiesInput["deviceRole"];
  /** URL of the ACL file when `configurationType` is `File`. */
  aclsUrl?: string;
  /** Action when no match configuration matches (`Permit` or `Deny`). */
  defaultAction?: mnf.AccessControlListPropertiesInput["defaultAction"];
  /**
   * Inline match configurations: conditions (protocols, IPs, ports, VLANs)
   * and the actions to take when they match. Required for `Inline` ACLs;
   * sequence numbers must be greater than 1000.
   */
  matchConfigurations?: mnf.AccessControlListPropertiesInput["matchConfigurations"];
  /** Named IP, VLAN, and port groups that match configurations reference. */
  dynamicMatchConfigurations?: mnf.AccessControlListPropertiesInput["dynamicMatchConfigurations"];
  /** Global ACL actions, e.g. enabling match counters. */
  globalAccessControlListActions?: mnf.AccessControlListPropertiesInput["globalAccessControlListActions"];
  /** Control-plane ACL entries (for `ControlPlaneAcl` ACLs). */
  controlPlaneAclConfiguration?: mnf.AccessControlListPropertiesInput["controlPlaneAclConfiguration"];
  /** Free-form description. */
  annotation?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface AccessControlList extends Resource<
  "Azure.ManagedNetworkFabric.AccessControlList",
  AccessControlListProps,
  {
    /** Name of the access control list. */
    accessControlListName: string;
    /** ARM resource ID of the access control list. */
    accessControlListId: string;
    /** Resource group that holds the access control list. */
    resourceGroup: string;
    /** Location of the access control list. */
    location: string;
    /** Network Fabrics the ACL is attached to. */
    networkFabricIds: string[];
    /** Description of the access control list. */
    annotation: string | undefined;
    /** Provisioning state, e.g. `Succeeded`. */
    provisioningState: string | undefined;
    /** Configuration state on the fabric devices, e.g. `Succeeded`. */
    configurationState: string | undefined;
    /** Administrative state, e.g. `Enabled` or `Disabled`. */
    administrativeState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Operator Nexus access control list — permit/deny/count rules
 * that fabric devices apply to traffic on network-to-network interconnects and
 * isolation-domain networks. The ACL is plain ARM configuration until a fabric
 * resource references it.
 *
 * @see https://learn.microsoft.com/azure/operator-nexus/howto-create-access-control-list-for-network-to-network-interconnects
 *
 * ### Creating an ACL
 * **Example:** Inline ACL that drops one subnet
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("fabric");
 * const acl = yield* Azure.ManagedNetworkFabric.AccessControlList("ingress", {
 *   resourceGroup: group.resourceGroupName,
 *   configurationType: "Inline",
 *   defaultAction: "Permit",
 *   matchConfigurations: [
 *     {
 *       matchConfigurationName: "drop-bad-subnet",
 *       sequenceNumber: 1100,
 *       ipAddressType: "IPv4",
 *       matchConditions: [
 *         {
 *           ipCondition: {
 *             type: "SourceIP",
 *             prefixType: "Prefix",
 *             ipPrefixValues: ["10.20.0.0/16"],
 *           },
 *         },
 *       ],
 *       actions: [{ type: "Drop" }],
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const AccessControlList = Resource<AccessControlList>(
  "Azure.ManagedNetworkFabric.AccessControlList",
);

type Observed = mnf.GetAccessControlListResponse;

const getAccessControlList = (
  subscriptionId: string,
  resourceGroupName: string,
  accessControlListName: string,
) =>
  orUndefinedIfNotFound(
    mnf.GetAccessControlList({
      subscriptionId,
      resourceGroupName,
      accessControlListName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed,
): AccessControlList["Attributes"] => {
  const p = observed.properties;
  return {
    accessControlListName: name,
    accessControlListId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    networkFabricIds: [...(p?.networkFabricIds ?? [])],
    annotation: p?.annotation,
    provisioningState: p?.provisioningState,
    configurationState: p?.configurationState,
    administrativeState: p?.administrativeState,
    tags: userTags(observed.tags),
  };
};

export const AccessControlListProvider = () =>
  Provider.succeed(AccessControlList, {
    stables: [
      "accessControlListName",
      "accessControlListId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* mnf
        .ListAccessControlListBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListAccessControlListBySubscription", page),
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
          !sameArm(news.name, output.accessControlListName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        (olds !== undefined &&
          (differs(news.configurationType, olds.configurationType) ||
            differs(news.aclType, olds.aclType) ||
            differs(news.deviceRole, olds.deviceRole)))
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
        output?.accessControlListName ??
        olds?.name ??
        (yield* createFabricName(id));
      const observed = yield* getAccessControlList(
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
        output?.accessControlListName ??
        (yield* createFabricName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accessControlListName: name,
      };
      const label = `access control list ${name}`;
      const get = getAccessControlList(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* mnf.CreateAccessControlList({
          ...where,
          location,
          tags,
          properties: {
            configurationType: news.configurationType,
            aclType: news.aclType,
            deviceRole: news.deviceRole,
            aclsUrl: news.aclsUrl,
            defaultAction: news.defaultAction,
            matchConfigurations: news.matchConfigurations,
            dynamicMatchConfigurations: news.dynamicMatchConfigurations,
            globalAccessControlListActions: news.globalAccessControlListActions,
            controlPlaneAclConfiguration: news.controlPlaneAclConfiguration,
            annotation: news.annotation,
          },
        });
      }
      observed = yield* waitFabricProvisioned(label, get);

      // Sync mutable aspects against observed state; send only the delta.
      const delta = propertyDelta(observed.properties, {
        aclsUrl: news.aclsUrl,
        defaultAction: news.defaultAction,
        matchConfigurations: news.matchConfigurations,
        dynamicMatchConfigurations: news.dynamicMatchConfigurations,
        globalAccessControlListActions: news.globalAccessControlListActions,
        controlPlaneAclConfiguration: news.controlPlaneAclConfiguration,
        annotation: news.annotation,
      });
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (delta !== undefined || tagsChanged) {
        yield* mnf.UpdateAccessControlList({
          ...where,
          tags: tagsChanged ? tags : undefined,
          // The service rejects a PATCH without `configurationType`.
          properties: {
            ...delta,
            configurationType: news.configurationType,
          },
        });
        observed = yield* waitFabricProvisioned(label, get);
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        accessControlListName: output.accessControlListName,
      };
      const label = `access control list ${output.accessControlListName}`;
      const get = getAccessControlList(
        subscriptionId,
        output.resourceGroup,
        output.accessControlListName,
      );
      // Fabric-bound resources must be administratively disabled first.
      const current = yield* get;
      if (current?.properties?.administrativeState === "Enabled") {
        yield* mnf.UpdateAccessControlListAdministrativeState({
          ...where,
          state: "Disable",
        });
        yield* waitFabricProvisioned(label, get);
      }
      yield* ignoreNotFound(mnf.DeleteAccessControlList(where));
      yield* waitUntilGone(label, get, { interval: "5 seconds", times: 60 });
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
