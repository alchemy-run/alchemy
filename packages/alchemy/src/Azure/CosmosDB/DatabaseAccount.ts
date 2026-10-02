import * as cosmos from "@distilled.cloud/azure/cosmos_db";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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
import { canonical, whileAccountBusy } from "./Shared.ts";

export type DatabaseAccountKind = "GlobalDocumentDB" | "MongoDB";

/**
 * Account capabilities. `EnableServerless` and the API capabilities
 * (`EnableTable`, `EnableCassandra`, `EnableGremlin`, `EnableMongo`) can
 * only be set when the account is created.
 */
export type DatabaseAccountCapability =
  | "EnableServerless"
  | "EnableTable"
  | "EnableCassandra"
  | "EnableGremlin"
  | "EnableMongo"
  | "EnableMongoRoleBasedAccessControl"
  | "EnableNoSQLVectorSearch"
  | "EnableNoSQLFullTextSearch"
  | (string & {});

export type ConsistencyLevel =
  | "Eventual"
  | "Session"
  | "BoundedStaleness"
  | "Strong"
  | "ConsistentPrefix";

export interface DatabaseAccountConsistencyPolicy {
  /** Default consistency level for reads. */
  defaultConsistencyLevel: ConsistencyLevel;
  /**
   * Number of stale requests tolerated (1 - 2,147,483,647). Required for
   * `BoundedStaleness`.
   */
  maxStalenessPrefix?: number;
  /** Staleness window in seconds (5 - 86400). Required for `BoundedStaleness`. */
  maxIntervalInSeconds?: number;
}

export interface DatabaseAccountLocation {
  /** Azure region, e.g. `eastus`. */
  locationName: string;
  /** Failover priority; `0` is the write region. Must be unique per region. */
  failoverPriority: number;
  /**
   * Spread the region's replicas across availability zones.
   * @default false
   */
  isZoneRedundant?: boolean;
}

export interface DatabaseAccountVirtualNetworkRule {
  /** ARM ID of the subnet allowed to reach the account. */
  id: string;
  /**
   * Create the rule before the subnet has the `Microsoft.AzureCosmosDB`
   * service endpoint enabled.
   */
  ignoreMissingVNetServiceEndpoint?: boolean;
}

export interface DatabaseAccountCorsRule {
  /** Comma-separated origins allowed to call the account. */
  allowedOrigins: string;
  /** Comma-separated HTTP methods. */
  allowedMethods?: string;
  /** Comma-separated request headers. */
  allowedHeaders?: string;
  /** Comma-separated response headers exposed to the browser. */
  exposedHeaders?: string;
  /** Preflight cache duration in seconds. */
  maxAgeInSeconds?: number;
}

export interface DatabaseAccountProps {
  /** Resource group the account is created in. Changing it replaces the account. */
  resourceGroup: string;
  /**
   * Globally unique account name: 3-44 lowercase letters, digits, and
   * hyphens, not starting or ending with a hyphen. If omitted, a unique name
   * is generated from the app, stage, and logical ID. Changing it replaces
   * the account.
   */
  name?: string;
  /**
   * Azure location of the account (its resource location). Changing it
   * replaces the account.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * API kind. `GlobalDocumentDB` serves the NoSQL, Table, Cassandra, and
   * Gremlin APIs (with the matching capability); `MongoDB` serves the API
   * for MongoDB. Changing it replaces the account.
   * @default "GlobalDocumentDB"
   */
  kind?: DatabaseAccountKind;
  /**
   * Account capabilities, e.g. `["EnableServerless"]` for a serverless
   * account or `["EnableTable"]` for the Table API. Adding or removing a
   * create-only capability (`EnableServerless`, `EnableTable`,
   * `EnableCassandra`, `EnableGremlin`, `EnableMongo`) replaces the account;
   * other capabilities are added in place.
   */
  capabilities?: DatabaseAccountCapability[];
  /**
   * Replication regions. Region changes are applied in place but take
   * several minutes per region.
   * @default a single region at `location` with failover priority 0
   */
  locations?: DatabaseAccountLocation[];
  /**
   * Default consistency policy.
   * @default { defaultConsistencyLevel: "Session" }
   */
  consistencyPolicy?: DatabaseAccountConsistencyPolicy;
  /**
   * Use the Cosmos DB free tier (1000 RU/s and 25 GB free). Only one account
   * per subscription can use it. Changing it replaces the account.
   * @default false
   */
  enableFreeTier?: boolean;
  /** Automatically fail over the write region during a regional outage. */
  enableAutomaticFailover?: boolean;
  /** Accept writes in every region (multi-region writes). */
  enableMultipleWriteLocations?: boolean;
  /**
   * Whether the public endpoint accepts traffic.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /** IPv4 addresses or CIDR ranges allowed through the firewall. */
  ipRules?: string[];
  /** Enforce `virtualNetworkRules`. */
  isVirtualNetworkFilterEnabled?: boolean;
  /** Subnets allowed through the firewall. */
  virtualNetworkRules?: DatabaseAccountVirtualNetworkRule[];
  /** Let trusted Azure services bypass the firewall. */
  networkAclBypass?: "None" | "AzureServices";
  /**
   * Reject account-key authentication so only Microsoft Entra ID (RBAC via
   * `SqlRoleAssignment`) can access data.
   */
  disableLocalAuth?: boolean;
  /** Reject metadata writes (databases, containers, throughput) made with account keys. */
  disableKeyBasedMetadataWriteAccess?: boolean;
  /**
   * Minimum TLS version accepted by the endpoints.
   * @default "Tls12"
   */
  minimalTlsVersion?: "Tls" | "Tls11" | "Tls12";
  /**
   * Upper bound on the total provisioned throughput (RU/s) across the
   * account; `-1` removes the limit. A useful cost guard.
   */
  totalThroughputLimit?: number;
  /** MongoDB wire-protocol version, e.g. `"4.2"` or `"7.0"` (kind `MongoDB` only). */
  serverVersion?: string;
  /** Enable the analytical store (Synapse Link). Cannot be disabled once enabled. */
  enableAnalyticalStorage?: boolean;
  /** CORS rules for browser access. */
  cors?: DatabaseAccountCorsRule[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface DatabaseAccount extends Resource<
  "Azure.CosmosDB.DatabaseAccount",
  DatabaseAccountProps,
  {
    /** Name of the account. */
    accountName: string;
    /** ARM resource ID of the account; use it as a role-assignment scope. */
    accountId: string;
    /** Resource group that holds the account. */
    resourceGroup: string;
    /** Location of the account (lowercase, no spaces, e.g. `eastus`). */
    location: string;
    /** API kind. */
    kind: string;
    /** Data-plane endpoint, e.g. `https://{name}.documents.azure.com:443/`. */
    documentEndpoint: string;
    /** Enabled capabilities. */
    capabilities: string[];
    /** Write regions. */
    writeLocations: string[];
    /** Read regions. */
    readLocations: string[];
    /** Whether the account uses the free tier. */
    enableFreeTier: boolean;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Cosmos DB database account — the globally distributed endpoint
 * that hosts NoSQL databases, MongoDB databases, or tables.
 *
 * Creating or deleting an account takes several minutes. Serverless
 * accounts (`capabilities: ["EnableServerless"]`) cost nothing while idle.
 *
 * @see https://learn.microsoft.com/azure/cosmos-db/introduction
 *
 * ### Creating an Account
 * **Example:** Serverless NoSQL account
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const account = yield* Azure.CosmosDB.DatabaseAccount("db", {
 *   resourceGroup: group.resourceGroupName,
 *   capabilities: ["EnableServerless"],
 * });
 * ```
 *
 * **Example:** Keyless account (Entra ID only)
 * ```typescript
 * const account = yield* Azure.CosmosDB.DatabaseAccount("db", {
 *   resourceGroup: group.resourceGroupName,
 *   capabilities: ["EnableServerless"],
 *   disableLocalAuth: true,
 * });
 * ```
 *
 * ### Other APIs
 * **Example:** API for MongoDB account
 * ```typescript
 * const mongo = yield* Azure.CosmosDB.DatabaseAccount("mongo", {
 *   resourceGroup: group.resourceGroupName,
 *   kind: "MongoDB",
 *   capabilities: ["EnableServerless", "EnableMongo"],
 *   serverVersion: "4.2",
 * });
 * ```
 *
 * **Example:** Table API account
 * ```typescript
 * const tables = yield* Azure.CosmosDB.DatabaseAccount("tables", {
 *   resourceGroup: group.resourceGroupName,
 *   capabilities: ["EnableServerless", "EnableTable"],
 * });
 * ```
 *
 * ### Replication
 * **Example:** Two regions with automatic failover
 * ```typescript
 * const account = yield* Azure.CosmosDB.DatabaseAccount("db", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "eastus",
 *   locations: [
 *     { locationName: "eastus", failoverPriority: 0 },
 *     { locationName: "westus", failoverPriority: 1 },
 *   ],
 *   enableAutomaticFailover: true,
 *   consistencyPolicy: { defaultConsistencyLevel: "Session" },
 * });
 * ```
 *
 * @resource
 */
export const DatabaseAccount = Resource<DatabaseAccount>(
  "Azure.CosmosDB.DatabaseAccount",
);

type ObservedAccount = cosmos.GetDatabaseAccountResponse;

/** Capabilities that can only be set when the account is created. */
const CREATE_ONLY_CAPABILITIES = new Set(
  [
    "EnableServerless",
    "EnableTable",
    "EnableCassandra",
    "EnableGremlin",
    "EnableMongo",
  ].map((c) => c.toLowerCase()),
);

const createOnly = (capabilities: readonly string[] | undefined) =>
  [...new Set((capabilities ?? []).map((c) => c.toLowerCase()))]
    .filter((c) => CREATE_ONLY_CAPABILITIES.has(c))
    .sort()
    .join(",");

/** Cosmos reports regions by display name (`East US`); compare as `eastus`. */
const normalizeLocation = (location: string | undefined) =>
  (location ?? "").toLowerCase().replace(/\s+/g, "");

const createAccountName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 44,
    lowercase: true,
  });
  return name
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
});

const getAccount = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
) =>
  orUndefinedIfNotFound(
    cosmos.GetDatabaseAccount({
      subscriptionId,
      resourceGroupName,
      accountName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  account: ObservedAccount,
): DatabaseAccount["Attributes"] => {
  const props = account.properties;
  return {
    accountName: name,
    accountId: account.id ?? "",
    resourceGroup,
    location: normalizeLocation(account.location),
    kind: account.kind ?? "GlobalDocumentDB",
    documentEndpoint: props?.documentEndpoint ?? "",
    capabilities: (props?.capabilities ?? []).flatMap((c) =>
      c.name ? [c.name] : [],
    ),
    writeLocations: (props?.writeLocations ?? []).map((l) =>
      normalizeLocation(l.locationName),
    ),
    readLocations: (props?.readLocations ?? []).map((l) =>
      normalizeLocation(l.locationName),
    ),
    enableFreeTier: props?.enableFreeTier ?? false,
    tags: userTags(account.tags),
  };
};

const desiredLocations = (
  news: DatabaseAccountProps,
  location: string,
): cosmos.LocationInput[] =>
  (
    news.locations ?? [{ locationName: location, failoverPriority: 0 }]
  ).map((l) => ({
    locationName: normalizeLocation(l.locationName),
    failoverPriority: l.failoverPriority,
    isZoneRedundant: l.isZoneRedundant ?? false,
  }));

const locationKey = (
  locations: ReadonlyArray<{
    locationName?: string;
    failoverPriority?: number;
    isZoneRedundant?: boolean;
  }>,
) =>
  [...locations]
    .map(
      (l) =>
        `${normalizeLocation(l.locationName)}:${l.failoverPriority ?? 0}:${l.isZoneRedundant ?? false}`,
    )
    .sort()
    .join(",");

/**
 * The PATCH body needed to move the observed account to the desired
 * properties; empty when converged. Unset props are left as observed.
 */
const propertyDelta = (
  news: DatabaseAccountProps,
  location: string,
  observed: ObservedAccount,
): cosmos.DatabaseAccountUpdatePropertiesInput => {
  const props: cosmos.DatabaseAccountGetProperties = observed.properties ?? {};
  const delta: cosmos.DatabaseAccountUpdatePropertiesInput = {};

  const consistency = news.consistencyPolicy ?? {
    defaultConsistencyLevel: "Session",
  };
  const observedConsistency = props.consistencyPolicy;
  if (
    observedConsistency?.defaultConsistencyLevel !==
      consistency.defaultConsistencyLevel ||
    (consistency.maxStalenessPrefix !== undefined &&
      observedConsistency?.maxStalenessPrefix !==
        consistency.maxStalenessPrefix) ||
    (consistency.maxIntervalInSeconds !== undefined &&
      observedConsistency?.maxIntervalInSeconds !==
        consistency.maxIntervalInSeconds)
  ) {
    delta.consistencyPolicy = consistency;
  }

  const locations = desiredLocations(news, location);
  if (locationKey(locations) !== locationKey(props.locations ?? [])) {
    delta.locations = locations;
  }

  // Capabilities are only added: Cosmos may enable some on its own.
  const observedCaps = new Set(
    (props.capabilities ?? []).flatMap((c) =>
      c.name ? [c.name.toLowerCase()] : [],
    ),
  );
  const missing = (news.capabilities ?? []).filter(
    (c) => !observedCaps.has(c.toLowerCase()),
  );
  if (missing.length > 0) {
    delta.capabilities = [
      ...(props.capabilities ?? []).flatMap((c) =>
        c.name ? [{ name: c.name }] : [],
      ),
      ...missing.map((name) => ({ name })),
    ];
  }

  const scalars = {
    enableAutomaticFailover: news.enableAutomaticFailover,
    enableMultipleWriteLocations: news.enableMultipleWriteLocations,
    publicNetworkAccess: news.publicNetworkAccess,
    isVirtualNetworkFilterEnabled: news.isVirtualNetworkFilterEnabled,
    networkAclBypass: news.networkAclBypass,
    disableLocalAuth: news.disableLocalAuth,
    disableKeyBasedMetadataWriteAccess: news.disableKeyBasedMetadataWriteAccess,
    minimalTlsVersion: news.minimalTlsVersion ?? "Tls12",
    enableAnalyticalStorage: news.enableAnalyticalStorage,
  } as const;
  for (const key of Object.keys(scalars) as (keyof typeof scalars)[]) {
    const value = scalars[key];
    if (value !== undefined && props[key] !== value) {
      Object.assign(delta, { [key]: value });
    }
  }

  if (news.ipRules !== undefined) {
    const desiredIps = [...news.ipRules].sort();
    const observedIps = (props.ipRules ?? [])
      .flatMap((r) => (r.ipAddressOrRange ? [r.ipAddressOrRange] : []))
      .sort();
    if (desiredIps.join(",") !== observedIps.join(",")) {
      delta.ipRules = desiredIps.map((ipAddressOrRange) => ({
        ipAddressOrRange,
      }));
    }
  }
  if (news.virtualNetworkRules !== undefined) {
    const key = (rules: ReadonlyArray<{ id?: string }>) =>
      rules
        .map((r) => (r.id ?? "").toLowerCase())
        .sort()
        .join(",");
    if (key(news.virtualNetworkRules) !== key(props.virtualNetworkRules ?? [])) {
      delta.virtualNetworkRules = news.virtualNetworkRules;
    }
  }
  if (
    news.totalThroughputLimit !== undefined &&
    props.capacity?.totalThroughputLimit !== news.totalThroughputLimit
  ) {
    delta.capacity = { totalThroughputLimit: news.totalThroughputLimit };
  }
  if (
    news.serverVersion !== undefined &&
    props.apiProperties?.serverVersion !== news.serverVersion
  ) {
    delta.apiProperties = { serverVersion: news.serverVersion };
  }
  if (
    news.cors !== undefined &&
    canonical(news.cors) !== canonical(props.cors ?? [])
  ) {
    delta.cors = news.cors;
  }
  return delta;
};

const isEmpty = (value: object) => Object.keys(value).length === 0;

export const DatabaseAccountProvider = () =>
  Provider.succeed(DatabaseAccount, {
    stables: [
      "accountName",
      "accountId",
      "resourceGroup",
      "location",
      "kind",
      "documentEndpoint",
      "enableFreeTier",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* cosmos
        .ListDatabaseAccounts({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListDatabaseAccounts", page),
          ),
        );
      return (page.value ?? []).flatMap((account) => {
        const group = resourceGroupOf(account.id);
        return hasAnyAlchemyTag(account.tags) &&
          group !== undefined &&
          account.name !== undefined
          ? [toAttrs(group, account.name, account)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined && news.name !== output.accountName) ||
        (news.location !== undefined &&
          normalizeLocation(news.location) !== output.location) ||
        (news.kind ?? "GlobalDocumentDB") !== output.kind ||
        (news.enableFreeTier ?? false) !== output.enableFreeTier ||
        createOnly(news.capabilities) !== createOnly(output.capabilities)
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
        output?.accountName ?? olds?.name ?? (yield* createAccountName(id));
      const observed = yield* getAccount(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.DocumentDB");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.accountName ?? (yield* createAccountName(id));
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.location,
      );
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: name,
      };
      const label = `Cosmos DB account ${name}`;
      const get = getAccount(subscriptionId, resourceGroup, name);
      // Converged once provisioning settled and no delta is left. A PATCH
      // is accepted before the GET reports `Updating`, so `Succeeded` alone
      // can be stale.
      const settle = waitForProvisioned(
        label,
        get,
        (account) => {
          const state = account.properties?.provisioningState;
          if (state !== "Succeeded") return state;
          return isEmpty(propertyDelta(news, location, account)) &&
            !tagsDiffer(account.tags, tags)
            ? "Succeeded"
            : "Updating";
        },
        { interval: "10 seconds", times: 90 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        const delta = propertyDelta(news, location, {});
        yield* cosmos.DatabaseAccountsCreateOrUpdate({
          ...where,
          location,
          tags,
          kind: news.kind ?? "GlobalDocumentDB",
          properties: {
            ...delta,
            databaseAccountOfferType: "Standard",
            locations: desiredLocations(news, location),
            capabilities: (news.capabilities ?? []).map((name) => ({ name })),
            enableFreeTier: news.enableFreeTier,
          },
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (account) => account.properties?.provisioningState,
          { interval: "10 seconds", times: 90 },
        );
      } else if (observed.properties?.provisioningState !== "Succeeded") {
        observed = yield* waitForProvisioned(
          label,
          get,
          (account) => account.properties?.provisioningState,
          { interval: "10 seconds", times: 90 },
        );
      }

      // Sync properties and tags against observed state; PATCH only deltas.
      const delta = propertyDelta(news, location, observed);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (!isEmpty(delta) || tagsChanged) {
        // Cosmos rejects a PATCH that changes locations together with other
        // properties, so regions are converged in their own call.
        const { locations, ...rest } = delta;
        if (!isEmpty(rest) || tagsChanged) {
          yield* cosmos
            .UpdateDatabaseAccount({
              ...where,
              tags: tagsChanged ? tags : undefined,
              properties: isEmpty(rest) ? undefined : rest,
            })
            .pipe(Effect.retry(whileAccountBusy));
        }
        if (locations !== undefined) {
          yield* waitForProvisioned(
            label,
            get,
            (account) => account.properties?.provisioningState,
            { interval: "10 seconds", times: 90 },
          );
          yield* cosmos
            .UpdateDatabaseAccount({ ...where, properties: { locations } })
            .pipe(Effect.retry(whileAccountBusy));
        }
        observed = yield* settle;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const get = getAccount(
        subscriptionId,
        output.resourceGroup,
        output.accountName,
      );
      // Cosmos holds an exclusive lock while the account is being created or
      // updated and rejects DELETE with `PreconditionFailed` until then.
      const observed = yield* get;
      const state = observed?.properties?.provisioningState;
      if (state === "Creating" || state === "Updating") {
        yield* get.pipe(
          Effect.repeat({
            until: (account) => {
              const s = account?.properties?.provisioningState;
              return s !== "Creating" && s !== "Updating";
            },
            schedule: Schedule.spaced("10 seconds"),
            times: 90,
          }),
        );
      }
      yield* ignoreNotFound(
        cosmos
          .DeleteDatabaseAccount({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.accountName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `Cosmos DB account ${output.accountName}`,
        getAccount(subscriptionId, output.resourceGroup, output.accountName),
        { interval: "10 seconds", times: 90 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
