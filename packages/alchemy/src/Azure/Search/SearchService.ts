import * as search from "@distilled.cloud/azure/search";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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
  createSearchName,
  deleteAllSharedPrivateLinks,
  getSearchService,
  SEARCH_NAMESPACE,
} from "./internal.ts";

export type SearchSkuName = search.SkuName;
export type SearchHostingMode = "Default" | "HighDensity";
export type SearchComputeType = "Default" | "Confidential";
export type SearchPublicNetworkAccess =
  | "Enabled"
  | "Disabled"
  | "SecuredByPerimeter";
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
   */
  userAssignedIdentities?: string[];
}

export interface SearchServiceProps {
  /** Resource group the service is created in. Changing it replaces the service. */
  resourceGroup: string;
  /**
   * Globally unique service name (it becomes
   * `https://{name}.search.windows.net`): 2-60 lowercase letters, digits,
   * and hyphens. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the service.
   */
  name?: string;
  /**
   * Azure location of the service. Changing it replaces the service.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Pricing tier. A subscription may hold only one `free` service, and the
   * `free` tier does not support replicas, partitions, IP rules, identities,
   * or semantic search. Changing it replaces the service.
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
   * `standard3`. Changing it replaces the service.
   * @default "Default"
   */
  hostingMode?: SearchHostingMode;
  /**
   * Run the service on default or Azure Confidential Compute. Changing it
   * replaces the service.
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
   * Every other public network is blocked once a rule exists. Pass `[]` to
   * remove all rules.
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
  /** Data exfiltration scenarios to block. Only `BlockAll` is supported. */
  dataExfiltrationProtections?: "BlockAll"[];
  /**
   * Whether the service enforces customer-managed-key encryption on its
   * indexes, synonym maps, and other objects.
   * @default Azure's default (`Unspecified`)
   */
  cmkEnforcement?: "Disabled" | "Enabled" | "Unspecified";
  /** Managed identity of the service. */
  identity?: SearchServiceIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
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
 * An Azure AI Search service — a managed search engine for full-text,
 * vector, and hybrid search over your indexes. The service exposes its
 * admin and query API keys as redacted attributes.
 *
 * @see https://learn.microsoft.com/azure/search/search-what-is-azure-search
 *
 * ### Creating a Search Service
 * **Example:** Basic search service
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const search = yield* Azure.Search.SearchService("search", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Standard tier with two replicas and semantic ranking
 * ```typescript
 * const search = yield* Azure.Search.SearchService("search", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "standard",
 *   replicaCount: 2,
 *   semanticSearch: "standard",
 * });
 * ```
 *
 * ### Securing the Service
 * **Example:** Entra ID or API keys, restricted to one network
 * ```typescript
 * const search = yield* Azure.Search.SearchService("search", {
 *   resourceGroup: group.resourceGroupName,
 *   authMode: "aadOrApiKey",
 *   aadAuthFailureMode: "http401WithBearerChallenge",
 *   ipRules: ["203.0.113.0/24"],
 *   identity: { type: "SystemAssigned" },
 * });
 * ```
 *
 * @resource
 */
export const SearchService = Resource<SearchService>(
  "Azure.Search.SearchService",
);

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
  endpoint:
    service.properties?.endpoint ?? `https://${name}.search.windows.net`,
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
    return service.properties?.status === "provisioning"
      ? "provisioning"
      : "Succeeded";
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
  if (
    news.replicaCount !== undefined &&
    news.replicaCount !== observed.replicaCount
  ) {
    delta.replicaCount = news.replicaCount;
  }
  if (
    news.partitionCount !== undefined &&
    news.partitionCount !== observed.partitionCount
  ) {
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
      (rules?.ipRules ?? []).flatMap((r) =>
        r.value === undefined ? [] : [r.value],
      );
    const bypass = news.bypass ?? rules?.bypass;
    if (
      sortedJoin(ipRules) !==
        sortedJoin((rules?.ipRules ?? []).map((r) => r.value)) ||
      (news.bypass !== undefined &&
        lower(news.bypass) !== lower(rules?.bypass ?? "None"))
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
      observed.authOptions?.aadOrApiKey !== undefined
        ? "aadOrApiKey"
        : "apiKeyOnly";
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
    lower(news.cmkEnforcement) !==
      lower(observed.encryptionWithCmk?.enforcement ?? "Unspecified")
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
    normalizeIdentityType(desired.type) ===
      normalizeIdentityType(observed?.type) &&
    sortedJoin(desiredIds) ===
      sortedJoin(Object.keys(observed?.userAssignedIdentities ?? {}))
  ) {
    return undefined;
  }
  return {
    type: desired.type,
    userAssignedIdentities:
      desiredIds.length > 0
        ? Object.fromEntries(desiredIds.map((id) => [id, {}]))
        : undefined,
  };
};

const WAIT = { interval: "15 seconds", times: 60 } as const;

export const SearchServiceProvider = () =>
  Provider.succeed(SearchService, {
    stables: [
      "searchServiceName",
      "searchServiceId",
      "resourceGroup",
      "location",
      "endpoint",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* search
        .ListServiceBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListServiceBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((service) => {
        const group = resourceGroupOf(service.id);
        return hasAnyAlchemyTag(service.tags) &&
          group !== undefined &&
          service.name !== undefined
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
      const name =
        output?.searchServiceName ??
        olds?.name ??
        (yield* createSearchName(id));
      const observed = yield* getSearchService(
        subscriptionId,
        resourceGroup,
        name,
      );
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
      const name =
        news.name ?? output?.searchServiceName ?? (yield* createSearchName(id));
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
      if (
        Object.keys(delta).length > 0 ||
        identity !== undefined ||
        tagsChanged
      ) {
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
        getSearchService(
          subscriptionId,
          output.resourceGroup,
          output.searchServiceName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
