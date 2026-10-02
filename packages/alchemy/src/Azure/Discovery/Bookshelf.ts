import * as discovery from "@distilled.cloud/azure/discovery";
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
import {
  createDiscoveryName,
  DISCOVERY_NAMESPACE,
  idSetKey,
  lower,
  sameLocation,
  toIdentityMap,
} from "./common.ts";

/** Customer-managed key used to encrypt a bookshelf's data at rest. */
export interface BookshelfKeyVaultKey {
  /** Key Vault URI. Changing it replaces the bookshelf. */
  keyVaultUri: string;
  /** Key name in the vault. */
  keyName: string;
  /** Key version; omit to track the latest version. */
  keyVersion?: string;
  /**
   * Client ID of the workload identity used to access the vault. Changing
   * it replaces the bookshelf.
   */
  identityClientId: string;
}

export interface BookshelfProps {
  /** Resource group the bookshelf is created in. Changing it replaces the bookshelf. */
  resourceGroup: string;
  /**
   * Bookshelf name: 3-24 letters, digits, and hyphens. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the bookshelf.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the bookshelf.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM IDs of user-assigned identities used by the knowledge-base
   * workloads. Changing them replaces the bookshelf.
   */
  workloadIdentities?: string[];
  /**
   * Encrypt data at rest with a customer-managed key. Changing it replaces
   * the bookshelf.
   * @default "Disabled"
   */
  customerManagedKeys?: "Enabled" | "Disabled";
  /** Customer-managed key, required when `customerManagedKeys` is `Enabled`. */
  keyVaultProperties?: BookshelfKeyVaultKey;
  /**
   * Log Analytics cluster for debug logs (required with customer-managed
   * keys). Changing it replaces the bookshelf.
   */
  logAnalyticsClusterId?: string;
  /**
   * Whether public network access is allowed.
   * @default Azure's default (`Disabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /** Subnet for private endpoint connections. Changing it replaces the bookshelf. */
  privateEndpointSubnetId?: string;
  /** Subnet for the search resources. Changing it replaces the bookshelf. */
  searchSubnetId?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Bookshelf extends Resource<
  "Azure.Discovery.Bookshelf",
  BookshelfProps,
  {
    /** Name of the bookshelf. */
    bookshelfName: string;
    /** ARM resource ID of the bookshelf. */
    bookshelfId: string;
    /** Resource group that holds the bookshelf. */
    resourceGroup: string;
    /** Location of the bookshelf. */
    location: string;
    /** Bookshelf endpoint URI. */
    bookshelfUri: string | undefined;
    /** Resource group Azure manages for the bookshelf's backing resources. */
    managedResourceGroup: string | undefined;
    /** Whether public network access is allowed. */
    publicNetworkAccess: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Microsoft Discovery bookshelf (`Microsoft.Discovery/bookshelves`) — a
 * knowledge base that indexes scientific literature and data for Discovery
 * agents, backed by Azure-managed search and storage.
 *
 * Microsoft Discovery is a gated preview: on subscriptions without the
 * preview, ARM rejects the resource type with `InvalidResourceType`.
 *
 * @see https://learn.microsoft.com/azure/microsoft-discovery/
 *
 * ### Creating a Bookshelf
 * **Example:** Bookshelf with a workload identity
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("science");
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("kb", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const bookshelf = yield* Azure.Discovery.Bookshelf("papers", {
 *   resourceGroup: group.resourceGroupName,
 *   workloadIdentities: [identity.identityId],
 * });
 * ```
 *
 * ### Networking
 * **Example:** Public network access
 * ```typescript
 * const bookshelf = yield* Azure.Discovery.Bookshelf("papers", {
 *   resourceGroup: group.resourceGroupName,
 *   publicNetworkAccess: "Enabled",
 * });
 * ```
 *
 * @resource
 */
export const Bookshelf = Resource<Bookshelf>("Azure.Discovery.Bookshelf");

const getBookshelf = (
  subscriptionId: string,
  resourceGroupName: string,
  bookshelfName: string,
) =>
  orUndefinedIfNotFound(
    discovery.GetBookshelve({
      subscriptionId,
      resourceGroupName,
      bookshelfName,
    }),
  ).pipe(
    Effect.catchTag("InvalidResourceType", () => Effect.succeed(undefined)),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Pick<
    discovery.GetBookshelveResponse,
    "id" | "location" | "properties" | "tags"
  >,
): Bookshelf["Attributes"] => ({
  bookshelfName: name,
  bookshelfId: observed.id ?? "",
  resourceGroup,
  location: observed.location,
  bookshelfUri: observed.properties?.bookshelfUri,
  managedResourceGroup: observed.properties?.managedResourceGroup,
  publicNetworkAccess: observed.properties?.publicNetworkAccess,
  tags: userTags(observed.tags),
});

export const BookshelfProvider = () =>
  Provider.succeed(Bookshelf, {
    stables: [
      "bookshelfName",
      "bookshelfId",
      "resourceGroup",
      "location",
      "bookshelfUri",
      "managedResourceGroup",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* discovery
        .ListBookshelveBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListBookshelveBySubscription", page),
          ),
          Effect.catchTag("InvalidResourceType", () =>
            Effect.succeed(undefined),
          ),
        );
      return (page?.value ?? []).flatMap((observed) => {
        const group = resourceGroupOf(observed.id);
        return hasAnyAlchemyTag(observed.tags) &&
          group !== undefined &&
          observed.name !== undefined
          ? [toAttrs(group, observed.name, observed)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.bookshelfName)) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        idSetKey(news.workloadIdentities) !==
          idSetKey(olds?.workloadIdentities) ||
        (news.customerManagedKeys ?? "Disabled") !==
          (olds?.customerManagedKeys ?? "Disabled") ||
        lower(news.keyVaultProperties?.keyVaultUri) !==
          lower(olds?.keyVaultProperties?.keyVaultUri) ||
        news.keyVaultProperties?.identityClientId !==
          olds?.keyVaultProperties?.identityClientId ||
        lower(news.logAnalyticsClusterId) !==
          lower(olds?.logAnalyticsClusterId) ||
        lower(news.privateEndpointSubnetId) !==
          lower(olds?.privateEndpointSubnetId) ||
        lower(news.searchSubnetId) !== lower(olds?.searchSubnetId)
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
        output?.bookshelfName ?? olds?.name ?? (yield* createDiscoveryName(id));
      const observed = yield* getBookshelf(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, DISCOVERY_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.bookshelfName ?? (yield* createDiscoveryName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        bookshelfName: name,
      };
      const get = getBookshelf(subscriptionId, resourceGroup, name);
      // A bookshelf provisions a managed resource group (search, storage).
      const ready = waitForProvisioned(
        `discovery bookshelf ${name}`,
        get,
        (bookshelf) => bookshelf.properties?.provisioningState,
        { interval: "15 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* discovery.BookshelvesCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: {
            workloadIdentities: toIdentityMap(news.workloadIdentities),
            customerManagedKeys: news.customerManagedKeys,
            keyVaultProperties: news.keyVaultProperties,
            logAnalyticsClusterId: news.logAnalyticsClusterId,
            publicNetworkAccess: news.publicNetworkAccess,
            privateEndpointSubnetId: news.privateEndpointSubnetId,
            searchSubnetId: news.searchSubnetId,
          },
        });
      }
      observed = yield* ready;

      // Sync the mutable aspects against observed state.
      const props = observed.properties;
      const accessChanged =
        news.publicNetworkAccess !== undefined &&
        props?.publicNetworkAccess !== news.publicNetworkAccess;
      const key = news.keyVaultProperties;
      const keyChanged =
        key !== undefined &&
        (props?.keyVaultProperties?.keyName !== key.keyName ||
          (key.keyVersion !== undefined &&
            props?.keyVaultProperties?.keyVersion !== key.keyVersion));
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (accessChanged || keyChanged || tagsChanged) {
        yield* discovery.UpdateBookshelve({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties:
            accessChanged || keyChanged
              ? {
                  publicNetworkAccess: accessChanged
                    ? news.publicNetworkAccess
                    : undefined,
                  keyVaultProperties:
                    keyChanged && key !== undefined
                      ? { keyName: key.keyName, keyVersion: key.keyVersion }
                      : undefined,
                }
              : undefined,
        });
        observed = yield* ready;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        discovery.DeleteBookshelve({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          bookshelfName: output.bookshelfName,
        }),
      ).pipe(Effect.catchTag("InvalidResourceType", () => Effect.void));
      yield* waitUntilGone(
        `discovery bookshelf ${output.bookshelfName}`,
        getBookshelf(
          subscriptionId,
          output.resourceGroup,
          output.bookshelfName,
        ),
        { interval: "15 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
