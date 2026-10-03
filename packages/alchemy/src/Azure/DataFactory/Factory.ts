import * as datafactory from "@distilled.cloud/azure/datafactory";
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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createHyphenName } from "./FactoryChild.ts";

export type FactoryIdentityType =
  | "SystemAssigned"
  | "UserAssigned"
  | "SystemAssigned,UserAssigned";

export interface FactoryIdentity {
  /** Identity type. */
  type: FactoryIdentityType;
  /**
   * ARM resource IDs of user-assigned identities attached to the factory.
   * Required when `type` includes `UserAssigned`.
   */
  userAssignedIdentities?: string[];
}

export interface FactoryEncryption {
  /** Name of the Key Vault key used for customer-managed-key encryption. */
  keyName: string;
  /** Key Vault URL, e.g. `https://my-vault.vault.azure.net`. */
  vaultBaseUrl: string;
  /** Key version. If omitted, the latest version is used. */
  keyVersion?: string;
  /**
   * ARM resource ID of the user-assigned identity Data Factory uses to
   * read the key. The identity must also be in `identity.userAssignedIdentities`.
   */
  userAssignedIdentity?: string;
}

export interface FactoryProps {
  /**
   * Resource group the factory is created in. Changing it replaces the
   * factory.
   */
  resourceGroup: string;
  /**
   * Globally unique factory name: 3-63 letters, digits, and single
   * hyphens, starting and ending with a letter or digit. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the factory.
   */
  name?: string;
  /**
   * Azure location of the factory. Changing it replaces the factory.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Managed identity of the factory. A system-assigned identity lets
   * linked services authenticate to Azure resources without secrets.
   * Removing the identity is not supported in place.
   */
  identity?: FactoryIdentity;
  /**
   * Whether the factory accepts traffic from public networks.
   * @default "Enabled"
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * ARM resource ID of a Microsoft Purview account that receives lineage
   * from this factory.
   */
  purviewResourceId?: string;
  /**
   * Customer-managed-key encryption. Can only be set on an empty factory,
   * so changing it replaces the factory.
   */
  encryption?: FactoryEncryption;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Factory extends Resource<
  "Azure.DataFactory.Factory",
  FactoryProps,
  {
    /** Name of the factory. */
    factoryName: string;
    /** Resource group that holds the factory. */
    resourceGroup: string;
    /** ARM resource ID of the factory. */
    factoryId: string;
    /** Location of the factory. */
    location: string;
    /** Provisioning state reported by Azure, e.g. `Succeeded`. */
    provisioningState: string | undefined;
    /** Time the factory was created (ISO 8601). */
    createTime: string | undefined;
    /** Factory version. */
    version: string | undefined;
    /** Identity type of the factory, if any. */
    identityType: string | undefined;
    /**
     * Object ID of the factory's system-assigned identity. Use it as the
     * `principalId` of a role assignment.
     */
    principalId: string | undefined;
    /** Microsoft Entra tenant of the factory's identity. */
    tenantId: string | undefined;
    /** Whether public network access is enabled. */
    publicNetworkAccess: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Data Factory — the managed ETL/ELT orchestration service that
 * holds pipelines, datasets, linked services, triggers, data flows, and
 * integration runtimes.
 *
 * An empty factory and its authoring objects are free; you pay per
 * pipeline/activity run, data flow vCore-hour, and integration runtime hour.
 *
 * @see https://learn.microsoft.com/azure/data-factory/introduction
 *
 * ### Creating a Factory
 * **Example:** Factory with a system-assigned identity
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("etl");
 * const factory = yield* Azure.DataFactory.Factory("etl", {
 *   resourceGroup: group.resourceGroupName,
 *   identity: { type: "SystemAssigned" },
 * });
 * ```
 *
 * **Example:** Private factory with tags
 * ```typescript
 * const factory = yield* Azure.DataFactory.Factory("etl", {
 *   resourceGroup: group.resourceGroupName,
 *   publicNetworkAccess: "Disabled",
 *   tags: { team: "data" },
 * });
 * ```
 *
 * ### Using User-Assigned Identities
 * **Example:** Attach a user-assigned identity for credentials
 * ```typescript
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("etl", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const factory = yield* Azure.DataFactory.Factory("etl", {
 *   resourceGroup: group.resourceGroupName,
 *   identity: {
 *     type: "SystemAssigned,UserAssigned",
 *     userAssignedIdentities: [identity.identityId],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Factory = Resource<Factory>("Azure.DataFactory.Factory");

type ObservedFactory = datafactory.GetFactoryResponse;

const getFactory = (
  subscriptionId: string,
  resourceGroupName: string,
  factoryName: string,
) =>
  orUndefinedIfNotFound(
    datafactory.GetFactory({ subscriptionId, resourceGroupName, factoryName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  factory: ObservedFactory,
): Factory["Attributes"] => ({
  factoryName: name,
  resourceGroup,
  factoryId: factory.id ?? "",
  location: factory.location ?? "",
  provisioningState: factory.properties?.provisioningState,
  createTime: factory.properties?.createTime,
  version: factory.properties?.version,
  identityType: factory.identity?.type,
  principalId: factory.identity?.principalId,
  tenantId: factory.identity?.tenantId,
  publicNetworkAccess: factory.properties?.publicNetworkAccess,
  tags: userTags(factory.tags),
});

const toIdentity = (
  identity: FactoryIdentity | undefined,
): datafactory.FactoryIdentity | undefined =>
  identity === undefined
    ? undefined
    : {
        type: identity.type,
        userAssignedIdentities: identity.userAssignedIdentities?.length
          ? Object.fromEntries(
              identity.userAssignedIdentities.map((id) => [id, {}]),
            )
          : undefined,
      };

const toEncryption = (
  encryption: FactoryEncryption | undefined,
): datafactory.EncryptionConfiguration | undefined =>
  encryption === undefined
    ? undefined
    : {
        keyName: encryption.keyName,
        vaultBaseUrl: encryption.vaultBaseUrl,
        keyVersion: encryption.keyVersion,
        identity: encryption.userAssignedIdentity
          ? { userAssignedIdentity: encryption.userAssignedIdentity }
          : undefined,
      };

const identityDiffers = (
  observed: datafactory.FactoryIdentity | undefined,
  desired: FactoryIdentity | undefined,
) => {
  if (desired === undefined) return false;
  if ((observed?.type ?? "").toLowerCase() !== desired.type.toLowerCase()) {
    return true;
  }
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  const want = (desired.userAssignedIdentities ?? [])
    .map((id) => id.toLowerCase())
    .sort();
  return have.length !== want.length || have.some((id, i) => id !== want[i]);
};

const encryptionKey = (encryption: FactoryEncryption | undefined) =>
  encryption === undefined
    ? ""
    : [
        encryption.keyName,
        encryption.vaultBaseUrl.replace(/\/+$/, "").toLowerCase(),
        encryption.keyVersion ?? "",
        (encryption.userAssignedIdentity ?? "").toLowerCase(),
      ].join("|");

export const FactoryProvider = () =>
  Provider.succeed(Factory, {
    stables: ["factoryName", "resourceGroup", "factoryId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* datafactory
        .ListFactories({ subscriptionId })
        .pipe(
          Effect.flatMap((page) => requireSinglePage("ListFactories", page)),
        );
      return (page.value ?? []).flatMap((factory) => {
        const group = resourceGroupOf(factory.id);
        return hasAnyAlchemyTag(factory.tags) &&
          group !== undefined &&
          factory.name !== undefined
          ? [toAttrs(group, factory.name, factory)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.factoryName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.toLowerCase() !== output.location.toLowerCase()) ||
        (olds !== undefined &&
          encryptionKey(news.encryption) !== encryptionKey(olds.encryption))
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
        output?.factoryName ?? olds?.name ?? (yield* createHyphenName(id));
      const observed = yield* getFactory(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.DataFactory");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.factoryName ?? (yield* createHyphenName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const publicNetworkAccess = news.publicNetworkAccess ?? "Enabled";
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        factoryName: name,
      };
      const get = getFactory(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT is synchronous and carries every create-time field.
      if (observed === undefined) {
        observed = yield* datafactory.FactoriesCreateOrUpdate({
          ...where,
          location,
          tags,
          identity: toIdentity(news.identity),
          properties: {
            publicNetworkAccess,
            purviewConfiguration: news.purviewResourceId
              ? { purviewResourceId: news.purviewResourceId }
              : undefined,
            encryption: toEncryption(news.encryption),
          },
        });
      }

      // Sync Purview. Only the PUT carries it, and the PUT replaces all
      // properties, so the observed global parameters and encryption ride
      // along unchanged.
      const observedPurview =
        observed.properties?.purviewConfiguration?.purviewResourceId ?? "";
      if (
        observedPurview.toLowerCase() !==
        (news.purviewResourceId ?? "").toLowerCase()
      ) {
        observed = yield* datafactory.FactoriesCreateOrUpdate({
          ...where,
          location: observed.location ?? location,
          tags,
          identity: news.identity
            ? toIdentity(news.identity)
            : observed.identity,
          properties: {
            publicNetworkAccess,
            purviewConfiguration: news.purviewResourceId
              ? { purviewResourceId: news.purviewResourceId }
              : undefined,
            globalParameters: observed.properties?.globalParameters,
            encryption: observed.properties?.encryption,
          },
        });
      }

      // Sync tags, identity, and public network access via PATCH (only the
      // observed deltas).
      const patchIdentity = identityDiffers(observed.identity, news.identity);
      const patchAccess =
        (observed.properties?.publicNetworkAccess ?? "Enabled") !==
        publicNetworkAccess;
      if (tagsDiffer(observed.tags, tags) || patchIdentity || patchAccess) {
        yield* datafactory.UpdateFactory({
          ...where,
          tags,
          identity: patchIdentity ? toIdentity(news.identity) : undefined,
          properties: patchAccess ? { publicNetworkAccess } : undefined,
        });
      }

      const fresh = yield* waitForProvisioned(
        `data factory ${name}`,
        get,
        (factory) => factory.properties?.provisioningState,
        { interval: "2 seconds", times: 30 },
      );
      return toAttrs(resourceGroup, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        datafactory.DeleteFactory({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          factoryName: output.factoryName,
        }),
      );
      yield* waitUntilGone(
        `data factory ${output.factoryName}`,
        getFactory(subscriptionId, output.resourceGroup, output.factoryName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
