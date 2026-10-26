import * as search from "@distilled.cloud/azure/search";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  createSearchName,
  deleteAllSharedPrivateLinks,
  getSearchService,
  SEARCH_NAMESPACE,
} from "./internal.ts";

export type SearchSkuName = search.SkuName;
export type SearchHostingMode = "Default" | "HighDensity";
export type SearchComputeType = "Default" | "Confidential";
export type SearchPublicNetworkAccess = "Enabled" | "Disabled" | "SecuredByPerimeter";
export type SearchSemanticSearchPlan = "disabled" | "free" | "standard";
export type SearchAadAuthFailureMode = "http403" | "http401WithBearerChallenge";
export type SearchIdentityType =
  | "None"
  | "SystemAssigned"
  | "UserAssigned"
  | "SystemAssigned, UserAssigned";

export interface SearchServiceIdentity {
  /** Identity type. `None` removes every identity. */
  type: SearchIdentityType;
  /**
   * ARM resource IDs of user-assigned managed identities to attach. Only
   * used with `UserAssigned` or `SystemAssigned, UserAssigned`.
   * @default []
   */
  userAssignedIdentities?: string[];
}

export interface SearchServiceProps {
  /**
   * Resource group the service is created in.
   *
   * :::caution
   * Changing it replaces the service and deletes every index in it.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Globally unique service name (it becomes
   * `https://{name}.search.windows.net`): 2-60 lowercase letters, digits,
   * and hyphens.
   *
   * :::caution
   * Changing it replaces the service and deletes every index in it.
   * :::
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Azure location of the service, e.g. `centralus`.
   *
   * :::caution
   * Changing it replaces the service and deletes every index in it.
   * :::
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Pricing tier: `free`, `basic`, `standard`, `standard2`, `standard3`,
   * `storage_optimized_l1`, or `storage_optimized_l2`. A subscription may
   * hold only one `free` service, and `free` does not support replicas,
   * partitions, IP rules, identities, or semantic ranking.
   *
   * :::caution
   * Changing it replaces the service and deletes every index in it.
   * :::
   * @default "basic"
   */
  sku?: SearchSkuName;
  /**
   * Number of replicas: 1-12 for standard tiers, 1-3 for `basic`. Not
   * supported on `free`. Scaling is asynchronous; the deploy waits for it.
   * @default Azure's default (`1`)
   */
  replicaCount?: number;
  /**
   * Number of partitions: 1, 2, 3, 4, 6, or 12. Values above 1 need a
   * standard tier.
   * @default Azure's default (`1`)
   */
  partitionCount?: number;
  /**
   * `HighDensity` allows up to 1000 indexes and is only valid on
   * `standard3`. Alchemy sends it only at creation: a later change has no
   * effect. Declare a new service (a new logical ID) to switch modes.
   * @default "Default"
   */
  hostingMode?: SearchHostingMode;
  /**
   * Run the service on default or Azure Confidential Compute. Alchemy
   * sends it only at creation: a later change has no effect. Declare a new
   * service (a new logical ID) to switch.
   * @default "Default"
   */
  computeType?: SearchComputeType;
  /**
   * Whether the public endpoint accepts traffic. `Disabled` leaves private
   * endpoints as the only access path.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccess?: SearchPublicNetworkAccess;
  /**
   * IPv4 addresses or CIDR ranges allowed to reach the public endpoint.
   * Once a rule exists, every other public network is blocked. Pass `[]` to
   * remove all rules.
   * @default no rules (every network may connect)
   */
  ipRules?: string[];
  /**
   * Inbound traffic origins that bypass `ipRules`.
   * @default Azure's default (`None`)
   */
  bypass?: "None" | "AzureServices";
  /**
   * Reject API-key authentication on the data plane (Microsoft Entra ID
   * only). Mutually exclusive with `authMode`.
   * @default Azure's default (`false`)
   */
  disableLocalAuth?: boolean;
  /**
   * Data-plane authentication: API keys only, or API keys and Microsoft
   * Entra ID tokens.
   * @default Azure's default (`apiKeyOnly`)
   */
  authMode?: "apiKeyOnly" | "aadOrApiKey";
  /**
   * Response sent for failed Entra ID authentication when `authMode` is
   * `aadOrApiKey`.
   * @default "http401WithBearerChallenge" when `authMode` is `aadOrApiKey`
   */
  aadAuthFailureMode?: SearchAadAuthFailureMode;
  /**
   * Semantic ranker billing plan. Not available on `free`, and only in some
   * regions.
   * @default Azure's default
   */
  semanticSearch?: SearchSemanticSearchPlan;
  /**
   * Data exfiltration scenarios to block. Only `BlockAll` is supported.
   * @default []
   */
  dataExfiltrationProtections?: "BlockAll"[];
  /**
   * Whether the service enforces customer-managed-key encryption on its
   * indexes, synonym maps, and other objects.
   * @default Azure's default (`Unspecified`)
   */
  cmkEnforcement?: "Disabled" | "Enabled" | "Unspecified";
  /**
   * Managed identity of the service, used to reach data sources and
   * customer-managed keys.
   * @default no identity
   */
  identity?: SearchServiceIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface SearchService extends Resource<
  "Azure.Search.SearchService",
  SearchServiceProps,
  {
    /** Name of the search service. */
    searchServiceName: string;
    /** ARM resource ID of the service; use it as a role-assignment scope. */
    searchServiceId: string;
    /** Resource group that holds the service. */
    resourceGroup: string;
    /** Location of the service. */
    location: string;
    /** Pricing tier. */
    sku: string;
    /** Data-plane endpoint, e.g. `https://{name}.search.windows.net`. */
    endpoint: string;
    /** Number of replicas. */
    replicaCount: number | undefined;
    /** Number of partitions. */
    partitionCount: number | undefined;
    /** Public network access setting as reported by Azure. */
    publicNetworkAccess: string | undefined;
    /** Service status, e.g. `running`. */
    status: string | undefined;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** Primary admin API key (full read/write data-plane access). */
    primaryAdminKey: Redacted.Redacted<string> | undefined;
    /** Secondary admin API key. */
    secondaryAdminKey: Redacted.Redacted<string> | undefined;
    /** Default query API key (read-only data-plane access). */
    queryKey: Redacted.Redacted<string> | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure AI Search service (`Microsoft.Search/searchServices`): a
 * managed search engine for full-text, vector, and hybrid search over your
 * indexes.
 *
 * Alchemy creates a `basic` service (one replica, one partition) by
 * default. Runtimes query and load indexes through bindings on
 * `Azure.Search.SearchIndex`, which assign Search roles to the host's
 * Microsoft Entra identity; set `authMode: "aadOrApiKey"` so the service
 * accepts those tokens. The admin and query API keys are also exposed as
 * redacted attributes. Creating a service takes a few minutes; scaling
 * replicas or partitions is asynchronous, and the deploy waits for it.
 *
 * :::caution[Changing `name`, `location`, `sku`, or `resourceGroup` replaces the service]
 * Alchemy creates a new, empty service and deletes the old one with every
 * index and document in it.
 * :::
 *
 * See [What is Azure AI Search?](https://learn.microsoft.com/azure/search/search-what-is-azure-search).
 *
 * ### Creating a Search Service
 * **Example:** Basic service that accepts Entra ID tokens
 * ```typescript
 * const search = yield* Azure.Search.SearchService("Search", {
 *   sku: "basic",
 *   authMode: "aadOrApiKey",
 * });
 * // search.endpoint → "https://<name>.search.windows.net"
 * ```
 *
 * **Example:** Free service for experiments
 * ```typescript
 * // One free service per subscription; no replicas, partitions, or IP rules.
 * const search = yield* Azure.Search.SearchService("Search", {
 *   sku: "free",
 * });
 * ```
 *
 * ### Scaling
 * Change `replicaCount` (query throughput and availability) or
 * `partitionCount` (storage and indexing) and deploy again. Azure scales
 * the service in place.
 *
 * **Example:** Standard tier with two replicas and two partitions
 * ```typescript
 * const search = yield* Azure.Search.SearchService("Search", {
 *   sku: "standard",
 *   replicaCount: 2,
 *   partitionCount: 2,
 * });
 * ```
 *
 * **Example:** Semantic ranking
 * ```typescript
 * const search = yield* Azure.Search.SearchService("Search", {
 *   sku: "standard",
 *   semanticSearch: "standard",
 * });
 * ```
 *
 * ### Authentication
 * **Example:** Entra ID only (no API keys)
 * ```typescript
 * const search = yield* Azure.Search.SearchService("Search", {
 *   disableLocalAuth: true,
 * });
 * ```
 *
 * **Example:** API keys or Entra ID, with a 401 challenge on failure
 * ```typescript
 * const search = yield* Azure.Search.SearchService("Search", {
 *   authMode: "aadOrApiKey",
 *   aadAuthFailureMode: "http401WithBearerChallenge",
 * });
 * // search.primaryAdminKey and search.queryKey are Redacted
 * ```
 *
 * ### Network Access
 * **Example:** Allow one IP range and trusted Azure services
 * ```typescript
 * const search = yield* Azure.Search.SearchService("Search", {
 *   authMode: "aadOrApiKey",
 *   ipRules: ["203.0.113.0/24"],
 *   bypass: "AzureServices",
 * });
 * ```
 *
 * **Example:** Private-only service behind a private endpoint
 * ```typescript
 * const search = yield* Azure.Search.SearchService("Search", {
 *   authMode: "aadOrApiKey",
 *   publicNetworkAccess: "Disabled",
 * });
 * yield* Azure.Network.PrivateEndpoint("SearchEndpoint", {
 *   subnetId: subnet.subnetId,
 *   privateLinkServiceConnections: [
 *     { privateLinkServiceId: search.searchServiceId, groupIds: ["searchService"] },
 *   ],
 * });
 * ```
 *
 * **Example:** Reach a private storage account from the indexer
 * ```typescript
 * const search = yield* Azure.Search.SearchService("Search", {
 *   sku: "standard",
 *   identity: { type: "SystemAssigned" },
 * });
 * yield* Azure.Search.SharedPrivateLinkResource("Blobs", {
 *   searchService: search.searchServiceName,
 *   privateLinkResourceId: account.storageAccountId,
 *   groupId: "blob",
 * });
 * ```
 *
 * ### Binding to a runtime
 * Bind an index in the service, not the service itself. Each binding
 * assigns Search roles on that one index to the host's principal: the
 * managed identity on an Azure Function, Web App, Container App, container
 * group, or VM, or an Entra service principal on any other host.
 *
 * **Example:** Search an index from an Azure Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const hotels = yield* Hotels; // an Azure.Search.SearchIndex
 *     const index = yield* Azure.Search.SearchIndexRead(hotels);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const results = yield* index.search({ search: "beach", top: 10 });
 *         return yield* HttpServerResponse.json(results.value);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Search.SearchIndexReadHttp)),
 * ) {}
 * ```
 *
 * ### Deleting a Service
 * Destroying the service deletes its shared private links first, then the
 * service with every index and document in it.
 *
 * **Example:** Keep the service when the stack is destroyed
 * ```typescript
 * import * as RemovalPolicy from "alchemy/RemovalPolicy";
 *
 * const search = yield* Azure.Search.SearchService("Search", {
 *   authMode: "aadOrApiKey",
 * }).pipe(RemovalPolicy.retain());
 * ```
 *
 * @resource
 */
export const SearchService = GroupedResource<SearchService>("Azure.Search.SearchService");

type ObservedService = search.GetServiceResponse;

interface ServiceKeys {
  primaryAdminKey: Redacted.Redacted<string> | undefined;
  secondaryAdminKey: Redacted.Redacted<string> | undefined;
  queryKey: Redacted.Redacted<string> | undefined;
}

const NO_KEYS: ServiceKeys = {
  primaryAdminKey: undefined,
  secondaryAdminKey: undefined,
  queryKey: undefined,
};

const redact = (value: string | undefined) =>
  value === undefined ? undefined : Redacted.make(value);

const toAttrs = (
  resourceGroup: string,
  name: string,
  service: ObservedService,
  keys: ServiceKeys,
): SearchService["Attributes"] => ({
  searchServiceName: name,
  searchServiceId: service.id ?? "",
  resourceGroup,
  location: service.location,
  sku: service.sku?.name ?? "",
  endpoint: service.properties?.endpoint ?? `https://${name}.search.windows.net`,
  replicaCount: service.properties?.replicaCount,
  partitionCount: service.properties?.partitionCount,
  publicNetworkAccess: service.properties?.publicNetworkAccess,
  status: service.properties?.status,
  principalId: service.identity?.principalId,
  ...keys,
  tags: userTags(service.tags),
});

const lower = (value: string | undefined | null) => value?.toLowerCase();

/**
 * Search reports lowercase `provisioningState` and keeps `status:
 * provisioning` while replicas or partitions scale; map both onto the
 * `Succeeded`/`Failed` vocabulary `waitForProvisioned` expects.
 */
const serviceState = (service: ObservedService) => {
  const state = lower(service.properties?.provisioningState);
  if (state === "failed") return "Failed";
  if (state === "succeeded") {
    return service.properties?.status === "provisioning" ? "provisioning" : "Succeeded";
  }
  return state ?? "provisioning";
};

const sortedJoin = (values: readonly (string | undefined)[] | undefined) =>
  (values ?? [])
    .flatMap((v) => (v === undefined ? [] : [v.toLowerCase()]))
    .sort()
    .join(",");

const normalizeIdentityType = (type: string | undefined) =>
  (type ?? "None").replace(/\s/g, "").toLowerCase();

const readKeys = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  searchServiceName: string,
) {
  const where = { subscriptionId, resourceGroupName, searchServiceName };
  const admin = yield* search.GetAdminKey(where);
  const query = yield* search.QueryKeysListBySearchService(where);
  return {
    primaryAdminKey: redact(admin.primaryKey),
    secondaryAdminKey: redact(admin.secondaryKey),
    queryKey: redact(query.value?.[0]?.key),
  } satisfies ServiceKeys;
});

/** Mutable properties whose observed value differs from the desired value. */
const propertyDelta = (
  news: SearchServiceProps,
  observed: search.SearchServiceProperties,
): search.SearchServicePropertiesInput => {
  const delta: search.SearchServicePropertiesInput = {};
  if (news.replicaCount !== undefined && news.replicaCount !== observed.replicaCount) {
    delta.replicaCount = news.replicaCount;
  }
  if (news.partitionCount !== undefined && news.partitionCount !== observed.partitionCount) {
    delta.partitionCount = news.partitionCount;
  }
  if (
    news.publicNetworkAccess !== undefined &&
    lower(news.publicNetworkAccess) !== lower(observed.publicNetworkAccess)
  ) {
    delta.publicNetworkAccess = news.publicNetworkAccess;
  }
  if (news.ipRules !== undefined || news.bypass !== undefined) {
    const rules = observed.networkRuleSet;
    const ipRules =
      news.ipRules ??
      (rules?.ipRules ?? []).flatMap((r) => (r.value === undefined ? [] : [r.value]));
    const bypass = news.bypass ?? rules?.bypass;
    if (
      sortedJoin(ipRules) !== sortedJoin((rules?.ipRules ?? []).map((r) => r.value)) ||
      (news.bypass !== undefined && lower(news.bypass) !== lower(rules?.bypass ?? "None"))
    ) {
      delta.networkRuleSet = {
        ipRules: ipRules.map((value) => ({ value })),
        bypass,
      };
    }
  }
  if (
    news.disableLocalAuth !== undefined &&
    news.disableLocalAuth !== (observed.disableLocalAuth ?? false)
  ) {
    delta.disableLocalAuth = news.disableLocalAuth;
  }
  if (news.authMode !== undefined && news.disableLocalAuth !== true) {
    const observedMode =
      observed.authOptions?.aadOrApiKey !== undefined ? "aadOrApiKey" : "apiKeyOnly";
    const failureMode = news.aadAuthFailureMode ?? "http401WithBearerChallenge";
    if (news.authMode === "aadOrApiKey") {
      if (
        observedMode !== "aadOrApiKey" ||
        observed.authOptions?.aadOrApiKey?.aadAuthFailureMode !== failureMode
      ) {
        delta.authOptions = {
          aadOrApiKey: { aadAuthFailureMode: failureMode },
        };
      }
    } else if (observedMode !== "apiKeyOnly") {
      delta.authOptions = { apiKeyOnly: {} };
    }
  }
  if (
    news.semanticSearch !== undefined &&
    news.semanticSearch !== (lower(observed.semanticSearch) ?? "disabled")
  ) {
    delta.semanticSearch = news.semanticSearch;
  }
  if (
    news.dataExfiltrationProtections !== undefined &&
    sortedJoin(news.dataExfiltrationProtections) !==
      sortedJoin(observed.dataExfiltrationProtections)
  ) {
    delta.dataExfiltrationProtections = news.dataExfiltrationProtections;
  }
  if (
    news.cmkEnforcement !== undefined &&
    lower(news.cmkEnforcement) !== lower(observed.encryptionWithCmk?.enforcement ?? "Unspecified")
  ) {
    delta.encryptionWithCmk = { enforcement: news.cmkEnforcement };
  }
  return delta;
};

const identityDelta = (
  desired: SearchServiceIdentity | undefined,
  observed: search.Identity | undefined,
): search.IdentityInput | undefined => {
  if (desired === undefined) return undefined;
  const desiredIds = desired.userAssignedIdentities ?? [];
  if (
    normalizeIdentityType(desired.type) === normalizeIdentityType(observed?.type) &&
    sortedJoin(desiredIds) === sortedJoin(Object.keys(observed?.userAssignedIdentities ?? {}))
  ) {
    return undefined;
  }
  return {
    type: desired.type,
    userAssignedIdentities:
      desiredIds.length > 0 ? Object.fromEntries(desiredIds.map((id) => [id, {}])) : undefined,
  };
};

const WAIT = { interval: "15 seconds", times: 60 } as const;

export const SearchServiceProvider = () =>
  Provider.succeed(SearchService, {
    stables: ["searchServiceName", "searchServiceId", "resourceGroup", "location", "endpoint"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(search.ListServiceBySubscription, { subscriptionId });
      return (page.value ?? []).flatMap((service) => {
        const group = resourceGroupOf(service.id);
        return hasAnyAlchemyTag(service.tags) && group !== undefined && service.name !== undefined
          ? [toAttrs(group, service.name, service, NO_KEYS)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.searchServiceName) ||
        (news.location !== undefined &&
          lower(news.location)?.replace(/\s/g, "") !==
            lower(output.location)?.replace(/\s/g, "")) ||
        lower(news.sku ?? "basic") !== lower(output.sku)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.searchServiceName ?? olds?.name ?? (yield* createSearchName(id));
      const observed = yield* getSearchService(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const keys = yield* readKeys(subscriptionId, resourceGroup, name);
      const attrs = toAttrs(resourceGroup, name, observed, keys);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, SEARCH_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.searchServiceName ?? (yield* createSearchName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        searchServiceName: name,
      };
      const get = getSearchService(subscriptionId, resourceGroup, name);
      const label = `search service ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is asynchronous: basic and standard services take
      // several minutes to reach `running`.
      if (observed === undefined) {
        const delta = propertyDelta(news, {});
        yield* search.ServicesCreateOrUpdate({
          ...where,
          location,
          sku: { name: news.sku ?? "basic" },
          tags,
          identity: identityDelta(news.identity, undefined),
          properties: {
            ...delta,
            hostingMode: news.hostingMode,
            computeType: news.computeType,
          },
        });
      }
      observed = yield* waitForProvisioned(label, get, serviceState, WAIT);

      // Sync mutable aspects against the observed service; PATCH only deltas.
      const delta = propertyDelta(news, observed.properties ?? {});
      const identity = identityDelta(news.identity, observed.identity);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (Object.keys(delta).length > 0 || identity !== undefined || tagsChanged) {
        yield* search.UpdateService({
          ...where,
          properties: Object.keys(delta).length > 0 ? delta : undefined,
          identity,
          tags: tagsChanged ? tags : undefined,
        });
        observed = yield* waitForProvisioned(label, get, serviceState, WAIT);
      }

      const keys = yield* readKeys(subscriptionId, resourceGroup, name);
      return toAttrs(resourceGroup, name, observed, keys);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* deleteAllSharedPrivateLinks(
        subscriptionId,
        output.resourceGroup,
        output.searchServiceName,
      );
      yield* ignoreNotFound(
        search.DeleteService({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          searchServiceName: output.searchServiceName,
        }),
      );
      yield* waitUntilGone(
        `search service ${output.searchServiceName}`,
        getSearchService(subscriptionId, output.resourceGroup, output.searchServiceName),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
