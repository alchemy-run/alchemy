import * as nc from "@distilled.cloud/azure/networkcloud";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createNexusName,
  customLocation,
  NEXUS_BUDGET,
  NEXUS_NAMESPACE,
  propertyDelta,
  sameArm,
  waitNexusProvisioned,
} from "./Common.ts";
import type { NexusKeySetUser } from "./Types.ts";

export interface BmcKeySetProps {
  /**
   * Resource group the BMC key set is created in. Changing it replaces the
   * BMC key set.
   */
  resourceGroup: string;
  /**
   * Name of the Nexus cluster the key set belongs to. Changing it replaces the BMC key set.
   */
  clusterName: string;
  /**
   * Name of the BMC key set. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the BMC key set.
   */
  name?: string;
  /**
   * Azure location of the BMC key set; must match the location of the Nexus
   * cluster. Changing it replaces the BMC key set.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the Nexus cluster's custom location (`clusterExtendedLocation`).
   * Changing it replaces the BMC key set.
   */
  customLocationId: string;
  /** Object ID of the Entra ID group whose members may use the key set. */
  azureGroupId: string;
  /** When the key set expires (ISO 8601 date-time). */
  expiration: string;
  /**
   * Access level: `ReadOnly` or `Administrator`. Changing it replaces the
   * key set.
   */
  privilegeLevel: "ReadOnly" | "Administrator";
  /** Users and their SSH public keys. */
  userList: NexusKeySetUser[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface BmcKeySet extends Resource<
  "Azure.NetworkCloud.BmcKeySet",
  BmcKeySetProps,
  {
    /** Name of the BMC key set. */
    bmcKeySetName: string;
    /** ARM resource ID of the BMC key set. */
    bmcKeySetId: string;
    /** Resource group that holds the BMC key set. */
    resourceGroup: string;
    /** Name of the parent Nexus cluster. */
    clusterName: string;
    /** Location of the BMC key set. */
    location: string;
    /** Custom location the BMC key set is deployed to. */
    customLocationId: string | undefined;
    /** When the key set was last validated. */
    lastValidation: string | undefined;
    /** Detailed status reported by the platform. */
    detailedStatus: string | undefined;
    /** Message describing the detailed status. */
    detailedStatusMessage: string | undefined;
    /** Provisioning state, e.g. `Succeeded`. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Operator Nexus BMC key set — SSH access for an Entra ID group to
 * the baseboard management controllers of a Nexus cluster's machines.
 * Needs a deployed Operator Nexus cluster.
 *
 * @see https://learn.microsoft.com/azure/operator-nexus/howto-baremetal-bmc-ssh
 *
 * ### Creating a BMC Key Set
 * **Example:** Read-only BMC access
 * ```typescript
 * const bmc = yield* Azure.NetworkCloud.BmcKeySet("bmc", {
 *   resourceGroup: cluster.resourceGroup,
 *   clusterName: cluster.clusterName,
 *   customLocationId: cluster.clusterExtendedLocationId,
 *   azureGroupId: "00000000-0000-0000-0000-000000000000",
 *   expiration: "2027-01-01T00:00:00Z",
 *   privilegeLevel: "ReadOnly",
 *   userList: [
 *     {
 *       azureUserName: "ops1",
 *       sshPublicKey: { keyData: "ssh-ed25519 AAAA..." },
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const BmcKeySet = Resource<BmcKeySet>("Azure.NetworkCloud.BmcKeySet");

type Observed = nc.GetBmcKeySetResponse;

const getBmcKeySet = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    nc.GetBmcKeySet({
      subscriptionId,
      resourceGroupName,
      clusterName,
      bmcKeySetName: name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  clusterName: string,
  name: string,
  observed: Observed,
): BmcKeySet["Attributes"] => {
  const p = observed.properties;
  return {
    bmcKeySetName: name,
    bmcKeySetId: observed.id ?? "",
    resourceGroup,
    clusterName,
    location: observed.location,
    customLocationId: observed.extendedLocation?.name,
    lastValidation: p.lastValidation,
    detailedStatus: p?.detailedStatus,
    detailedStatusMessage: p?.detailedStatusMessage,
    provisioningState: p?.provisioningState,
    tags: userTags(observed.tags),
  };
};

export const BmcKeySetProvider = () =>
  Provider.succeed(BmcKeySet, {
    stables: [
      "bmcKeySetName",
      "bmcKeySetId",
      "resourceGroup",
      "clusterName",
      "location",
      "customLocationId",
    ],

    // Children vanish with their cluster; the parent's list covers them.
    list: () => Effect.succeed([]),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.clusterName, output.clusterName) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.bmcKeySetName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        !sameArm(news.customLocationId, output.customLocationId) ||
        (olds !== undefined &&
          !sameArm(news.privilegeLevel, olds.privilegeLevel))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const clusterName = output?.clusterName ?? olds?.clusterName;
      if (clusterName === undefined) return undefined;
      const name =
        output?.bmcKeySetName ?? olds?.name ?? (yield* createNexusName(id, 63));
      const observed = yield* getBmcKeySet(
        subscriptionId,
        resourceGroup,
        clusterName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, clusterName, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, NEXUS_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const clusterName = news.clusterName;
      const name =
        news.name ?? output?.bmcKeySetName ?? (yield* createNexusName(id, 63));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterName,
        bmcKeySetName: name,
      };
      const label = `Nexus BMC key set ${name}`;
      const get = getBmcKeySet(
        subscriptionId,
        resourceGroup,
        clusterName,
        name,
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* nc.BmcKeySetsCreateOrUpdate({
          ...where,
          location,
          tags,
          extendedLocation: customLocation(news.customLocationId),
          properties: {
            azureGroupId: news.azureGroupId,
            expiration: news.expiration,
            privilegeLevel: news.privilegeLevel,
            userList: news.userList,
          },
        });
      }
      observed = yield* waitNexusProvisioned(label, get, NEXUS_BUDGET);

      // Sync mutable aspects against observed state; send only the delta.
      const expirationChanged =
        Date.parse(observed.properties.expiration) !==
        Date.parse(news.expiration);
      const listDelta = propertyDelta(observed.properties, {
        userList: news.userList,
      });
      const delta =
        listDelta === undefined && !expirationChanged
          ? undefined
          : {
              ...listDelta,
              expiration: expirationChanged ? news.expiration : undefined,
            };
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (delta !== undefined || tagsChanged) {
        yield* nc.UpdateBmcKeySet({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: delta,
        });
        observed = yield* waitNexusProvisioned(label, get, NEXUS_BUDGET);
      }

      return toAttrs(resourceGroup, clusterName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const name = output.bmcKeySetName;
      yield* ignoreNotFound(
        nc.DeleteBmcKeySet({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterName: output.clusterName,
          bmcKeySetName: name,
        }),
      );
      yield* waitUntilGone(
        `Nexus BMC key set ${name}`,
        getBmcKeySet(
          subscriptionId,
          output.resourceGroup,
          output.clusterName,
          name,
        ),
        NEXUS_BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.NetworkCloud.Cluster",
      ],
    },
  });
