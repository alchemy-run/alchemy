import * as signalr from "@distilled.cloud/azure/signalr";
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
  boolString,
  createSignalRName,
  enabledString,
  getSignalR,
  lower,
  sameLocation,
  SIGNALR_NAMESPACE,
  WAIT,
  whileSignalRBusy,
} from "./internal.ts";

export type SignalRSkuName =
  | "Free_F1"
  | "Standard_S1"
  | "Premium_P1"
  | "Premium_P2";
export type SignalRKind = "SignalR" | "RawWebSockets";
export type SignalRServiceMode = "Default" | "Serverless" | "Classic";
export type SignalRRequestType =
  | "ClientConnection"
  | "ServerConnection"
  | "RESTAPI"
  | "Trace";

export interface SignalRFeature {
  /**
   * Feature flag: `ServiceMode`, `EnableConnectivityLogs`,
   * `EnableMessagingLogs`, or `EnableLiveTrace`.
   */
  flag:
    | "ServiceMode"
    | "EnableConnectivityLogs"
    | "EnableMessagingLogs"
    | "EnableLiveTrace";
  /**
   * Flag value: `Default`/`Serverless`/`Classic` for `ServiceMode`,
   * `"true"`/`"false"` for the others.
   */
  value: string;
  /** Optional properties of the feature. */
  properties?: Record<string, string>;
}

export interface SignalRLogCategory {
  /** Category name: `ConnectivityLogs`, `MessagingLogs`, or `HttpRequestLogs`. */
  name: string;
  /** Whether the category is collected. */
  enabled: boolean;
}

export interface SignalRLiveTrace {
  /** Whether live trace clients may connect to the service. */
  enabled: boolean;
  /** Per-category live trace switches. */
  categories?: SignalRLogCategory[];
}

export interface SignalRUpstreamTemplate {
  /**
   * Upstream URL; may use `{hub}`, `{category}`, and `{event}`
   * placeholders, e.g. `https://example.com/{hub}/api/{event}`.
   */
  urlTemplate: string;
  /** Hub name pattern (`*`, `hub1,hub2`, or `hub1`). Matches any hub if omitted. */
  hubPattern?: string;
  /** Event name pattern. Matches any event if omitted. */
  eventPattern?: string;
  /** Category pattern (`connections`, `messages`). Matches any category if omitted. */
  categoryPattern?: string;
  /**
   * Upstream authentication: managed identity tokens for the given App ID
   * URI (`resource`). No auth if omitted.
   */
  auth?: {
    /** `None` or `ManagedIdentity`. */
    type: "None" | "ManagedIdentity";
    /** App ID URI placed in the token's `aud` claim (with `ManagedIdentity`). */
    resource?: string;
  };
}

export interface SignalRNetworkAcl {
  /** Request types allowed through this ACL. */
  allow?: SignalRRequestType[];
  /** Request types denied by this ACL. */
  deny?: SignalRRequestType[];
}

export interface SignalRPrivateEndpointAcl extends SignalRNetworkAcl {
  /** Name of the private endpoint connection the ACL applies to. */
  name: string;
}

export interface SignalRIpRule {
  /** IP address, CIDR range, or service tag. */
  value: string;
  /** Whether matching traffic is allowed or denied. */
  action: "Allow" | "Deny";
}

export interface SignalRNetworkAcls {
  /** Action applied to requests no ACL matches. */
  defaultAction: "Allow" | "Deny";
  /** ACL for requests from the public network. */
  publicNetwork?: SignalRNetworkAcl;
  /** ACLs for requests from private endpoints. */
  privateEndpoints?: SignalRPrivateEndpointAcl[];
  /** IP rules filtering public traffic. */
  ipRules?: SignalRIpRule[];
}

export interface SignalRIdentity {
  /** Identity type. `None` removes the identity. */
  type: "None" | "SystemAssigned" | "UserAssigned";
  /** ARM resource IDs of user-assigned identities (with `UserAssigned`). */
  userAssignedIdentities?: string[];
}

export interface SignalRProps {
  /** Resource group the service is created in. Changing it replaces the service. */
  resourceGroup: string;
  /**
   * Globally unique service name (it becomes `{name}.service.signalr.net`):
   * 3-63 letters, digits, and hyphens, starting with a letter. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the service.
   */
  name?: string;
  /**
   * Azure location of the service. Changing it replaces the service.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * `SignalR` for ASP.NET Core SignalR clients or `RawWebSockets`.
   * Changing it replaces the service.
   * @default "SignalR"
   */
  kind?: SignalRKind;
  /**
   * Pricing tier. A subscription may hold one `Free_F1` service per region.
   * Replicas, custom certificates, and custom domains need `Premium_P1` or
   * `Premium_P2`; shared private links need `Standard_S1` or higher.
   * @default "Free_F1"
   */
  sku?: SignalRSkuName;
  /**
   * Unit count: `1` for `Free_F1`; 1-10, 20, 30, ..., 100 for `Standard_S1`
   * and `Premium_P1`; 100, 200, ..., 1000 for `Premium_P2`.
   * @default Azure's default for the tier
   */
  capacity?: number;
  /**
   * Service mode: `Default` (your own hub server), `Serverless` (Azure
   * Functions / REST API, upstreams), or `Classic`. Shorthand for the
   * `ServiceMode` feature flag; wins over a `ServiceMode` entry in `features`.
   * @default Azure's default (`Default`)
   */
  serviceMode?: SignalRServiceMode;
  /**
   * Feature flags. Flags left out are not modified, so removing a flag
   * from this list keeps its last value.
   */
  features?: SignalRFeature[];
  /**
   * Origins allowed to make cross-origin calls, e.g.
   * `https://example.com:12345`. `["*"]` allows all.
   * @default Azure's default (`["*"]`)
   */
  allowedOrigins?: string[];
  /**
   * Upstream URL templates for serverless mode. Order matters; the first
   * matching template wins.
   */
  upstreamTemplates?: SignalRUpstreamTemplate[];
  /**
   * Seconds without a message (including keep-alive) after which a
   * serverless client is considered disconnected.
   * @default Azure's default (30)
   */
  connectionTimeoutInSeconds?: number;
  /**
   * Request a client certificate during the TLS handshake. Ignored on
   * `Free_F1`.
   * @default Azure's default (`false`)
   */
  clientCertEnabled?: boolean;
  /** Live trace settings. */
  liveTrace?: SignalRLiveTrace;
  /** Resource log categories sent to diagnostic settings. */
  resourceLogCategories?: SignalRLogCategory[];
  /** Network ACLs for public and private endpoint traffic. */
  networkAcls?: SignalRNetworkAcls;
  /**
   * Whether the public endpoint accepts traffic. When disabled, private
   * endpoints are the only access path regardless of `networkAcls`.
   * @default Azure's default (`true`)
   */
  publicNetworkAccess?: boolean;
  /**
   * Reject access-key authentication (Microsoft Entra ID only). The key
   * attributes are `undefined` while local auth is disabled.
   * @default Azure's default (`false`)
   */
  disableLocalAuth?: boolean;
  /**
   * Reject Microsoft Entra ID authentication (access keys only).
   * @default Azure's default (`false`)
   */
  disableAadAuth?: boolean;
  /**
   * Whether new connections are routed to this region's endpoint. Can only
   * be disabled on a service that has replicas.
   * @default Azure's default (`true`)
   */
  regionEndpointEnabled?: boolean;
  /**
   * Stop the data plane (`true`) or start it (`false`). Management
   * operations keep working while stopped.
   * @default Azure's default (`false`)
   */
  resourceStopped?: boolean;
  /** Managed identity of the service, e.g. for upstream auth or Key Vault certificates. */
  identity?: SignalRIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface SignalR extends Resource<
  "Azure.SignalR.SignalR",
  SignalRProps,
  {
    /** Name of the SignalR service. */
    signalRName: string;
    /** ARM resource ID of the service; use it as a role-assignment scope. */
    signalRId: string;
    /** Resource group that holds the service. */
    resourceGroup: string;
    /** Location of the service. */
    location: string;
    /** Service kind (`SignalR` or `RawWebSockets`). */
    kind: string;
    /** Pricing tier. */
    sku: string;
    /** Unit count. */
    capacity: number | undefined;
    /** Service FQDN, e.g. `{name}.service.signalr.net`. */
    hostName: string;
    /** HTTPS endpoint of the service, e.g. `https://{name}.service.signalr.net`. */
    endpoint: string;
    /** Public IP address of the service. */
    externalIP: string | undefined;
    /** Public port for client connections. */
    publicPort: number | undefined;
    /** Public port for server-side connections. */
    serverPort: number | undefined;
    /** Service version. */
    version: string | undefined;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** Tenant ID of the system-assigned identity, if any. */
    tenantId: string | undefined;
    /** Primary access key (undefined while local auth is disabled). */
    primaryKey: Redacted.Redacted<string> | undefined;
    /** Secondary access key. */
    secondaryKey: Redacted.Redacted<string> | undefined;
    /** Connection string built from the primary key. */
    primaryConnectionString: Redacted.Redacted<string> | undefined;
    /** Connection string built from the secondary key. */
    secondaryConnectionString: Redacted.Redacted<string> | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure SignalR Service — a managed real-time messaging service for
 * ASP.NET Core SignalR and raw WebSocket clients. The access keys and
 * connection strings are exposed as redacted attributes.
 *
 * @see https://learn.microsoft.com/azure/azure-signalr/signalr-overview
 *
 * ### Creating a Service
 * **Example:** Free tier service
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const signalR = yield* Azure.SignalR.SignalR("realtime", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Standard tier with two units and CORS
 * ```typescript
 * const signalR = yield* Azure.SignalR.SignalR("realtime", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Standard_S1",
 *   capacity: 2,
 *   allowedOrigins: ["https://app.example.com"],
 * });
 * ```
 *
 * ### Serverless Mode
 * **Example:** Serverless service with an upstream to Azure Functions
 * ```typescript
 * const signalR = yield* Azure.SignalR.SignalR("realtime", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceMode: "Serverless",
 *   upstreamTemplates: [
 *     {
 *       urlTemplate: "https://my-func.azurewebsites.net/runtime/webhooks/signalr?code=...",
 *       hubPattern: "*",
 *     },
 *   ],
 * });
 * ```
 *
 * ### Securing the Service
 * **Example:** Entra ID only, with a system-assigned identity
 * ```typescript
 * const signalR = yield* Azure.SignalR.SignalR("realtime", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Standard_S1",
 *   disableLocalAuth: true,
 *   identity: { type: "SystemAssigned" },
 * });
 * ```
 *
 * @resource
 */
export const SignalR = Resource<SignalR>("Azure.SignalR.SignalR");

type Observed = signalr.GetSignalRResponse;

interface Keys {
  primaryKey: Redacted.Redacted<string> | undefined;
  secondaryKey: Redacted.Redacted<string> | undefined;
  primaryConnectionString: Redacted.Redacted<string> | undefined;
  secondaryConnectionString: Redacted.Redacted<string> | undefined;
}

const NO_KEYS: Keys = {
  primaryKey: undefined,
  secondaryKey: undefined,
  primaryConnectionString: undefined,
  secondaryConnectionString: undefined,
};

const redact = (value: string | undefined) =>
  value === undefined ? undefined : Redacted.make(value);

const toAttrs = (
  resourceGroup: string,
  name: string,
  service: Observed,
  keys: Keys,
): SignalR["Attributes"] => {
  const hostName =
    service.properties?.hostName ?? `${name}.service.signalr.net`;
  return {
    signalRName: name,
    signalRId: service.id ?? "",
    resourceGroup,
    location: service.location,
    kind: service.kind ?? "SignalR",
    sku: service.sku?.name ?? "",
    capacity: service.sku?.capacity,
    hostName,
    endpoint: `https://${hostName}`,
    externalIP: service.properties?.externalIP,
    publicPort: service.properties?.publicPort,
    serverPort: service.properties?.serverPort,
    version: service.properties?.version,
    principalId: service.identity?.principalId,
    tenantId: service.identity?.tenantId,
    ...keys,
    tags: userTags(service.tags),
  };
};

const readKeys = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
  service: Observed,
) {
  if (service.properties?.disableLocalAuth === true) return NO_KEYS;
  const keys = yield* signalr.ListSignalRKeys({
    subscriptionId,
    resourceGroupName,
    resourceName,
  });
  return {
    primaryKey: redact(keys.primaryKey),
    secondaryKey: redact(keys.secondaryKey),
    primaryConnectionString: redact(keys.primaryConnectionString),
    secondaryConnectionString: redact(keys.secondaryConnectionString),
  } satisfies Keys;
});

const sortedJoin = (values: readonly (string | undefined)[] | undefined) =>
  (values ?? [])
    .flatMap((v) => (v === undefined ? [] : [v.toLowerCase()]))
    .sort()
    .join(",");

const categoriesKey = (
  categories:
    | readonly { name?: string; enabled?: string | boolean }[]
    | undefined,
) =>
  (categories ?? [])
    .map((c) => `${lower(c.name)}=${lower(String(c.enabled ?? "false"))}`)
    .sort()
    .join(",");

const aclKey = (acl: { allow?: readonly string[]; deny?: readonly string[] }) =>
  `${sortedJoin(acl.allow)}|${sortedJoin(acl.deny)}`;

const networkAclsKey = (acls: {
  defaultAction?: string;
  publicNetwork?: { allow?: readonly string[]; deny?: readonly string[] };
  privateEndpoints?: readonly {
    name: string;
    allow?: readonly string[];
    deny?: readonly string[];
  }[];
  ipRules?: readonly { value?: string; action?: string }[];
}) =>
  JSON.stringify([
    lower(acls.defaultAction),
    aclKey(acls.publicNetwork ?? {}),
    (acls.privateEndpoints ?? [])
      .map((pe) => `${lower(pe.name)}:${aclKey(pe)}`)
      .sort(),
    (acls.ipRules ?? [])
      .map((r) => `${lower(r.value)}:${lower(r.action)}`)
      .sort(),
  ]);

const upstreamKey = (
  templates: readonly {
    urlTemplate: string;
    hubPattern?: string;
    eventPattern?: string;
    categoryPattern?: string;
    auth?: { type?: string; managedIdentity?: { resource?: string } };
  }[],
) =>
  JSON.stringify(
    templates.map((t) => [
      t.urlTemplate,
      t.hubPattern ?? "*",
      t.eventPattern ?? "*",
      t.categoryPattern ?? "*",
      lower(t.auth?.type ?? "None"),
      t.auth?.managedIdentity?.resource ?? "",
    ]),
  );

const toUpstream = (
  templates: SignalRUpstreamTemplate[],
): signalr.UpstreamTemplate[] =>
  templates.map((t) => ({
    urlTemplate: t.urlTemplate,
    hubPattern: t.hubPattern,
    eventPattern: t.eventPattern,
    categoryPattern: t.categoryPattern,
    auth:
      t.auth === undefined
        ? undefined
        : {
            type: t.auth.type,
            managedIdentity:
              t.auth.resource === undefined
                ? undefined
                : { resource: t.auth.resource },
          },
  }));

const toCategories = (categories: SignalRLogCategory[] | undefined) =>
  categories?.map((c) => ({ name: c.name, enabled: boolString(c.enabled) }));

/** Desired feature flags, with `serviceMode` overriding a `ServiceMode` entry. */
const desiredFeatures = (news: SignalRProps): SignalRFeature[] => {
  const features = (news.features ?? []).filter(
    (f) => news.serviceMode === undefined || f.flag !== "ServiceMode",
  );
  return news.serviceMode === undefined
    ? features
    : [...features, { flag: "ServiceMode", value: news.serviceMode }];
};

const featureMatches = (
  desired: SignalRFeature,
  observed: readonly signalr.SignalRFeature[] | undefined,
) => {
  const current = observed?.find((f) => lower(f.flag) === lower(desired.flag));
  if (current === undefined) return false;
  if (lower(current.value) !== lower(desired.value)) return false;
  return (
    desired.properties === undefined ||
    JSON.stringify(Object.entries(desired.properties).sort()) ===
      JSON.stringify(Object.entries(current.properties ?? {}).sort())
  );
};

/** Mutable properties whose observed value differs from the desired value. */
const propertyDelta = (
  news: SignalRProps,
  observed: signalr.SignalRProperties,
): signalr.SignalRPropertiesInput => {
  const delta: signalr.SignalRPropertiesInput = {};
  const features = desiredFeatures(news);
  if (!features.every((f) => featureMatches(f, observed.features))) {
    delta.features = features;
  }
  if (
    news.allowedOrigins !== undefined &&
    sortedJoin(news.allowedOrigins) !==
      sortedJoin(observed.cors?.allowedOrigins ?? ["*"])
  ) {
    delta.cors = { allowedOrigins: news.allowedOrigins };
  }
  if (
    news.upstreamTemplates !== undefined &&
    upstreamKey(toUpstream(news.upstreamTemplates)) !==
      upstreamKey(observed.upstream?.templates ?? [])
  ) {
    delta.upstream = { templates: toUpstream(news.upstreamTemplates) };
  }
  if (
    news.connectionTimeoutInSeconds !== undefined &&
    news.connectionTimeoutInSeconds !==
      (observed.serverless?.connectionTimeoutInSeconds ?? 30)
  ) {
    delta.serverless = {
      connectionTimeoutInSeconds: news.connectionTimeoutInSeconds,
    };
  }
  if (
    news.clientCertEnabled !== undefined &&
    news.clientCertEnabled !== (observed.tls?.clientCertEnabled ?? false)
  ) {
    delta.tls = { clientCertEnabled: news.clientCertEnabled };
  }
  if (news.liveTrace !== undefined) {
    const current = observed.liveTraceConfiguration;
    if (
      boolString(news.liveTrace.enabled) !==
        lower(current?.enabled ?? "false") ||
      (news.liveTrace.categories !== undefined &&
        categoriesKey(news.liveTrace.categories) !==
          categoriesKey(current?.categories))
    ) {
      delta.liveTraceConfiguration = {
        enabled: boolString(news.liveTrace.enabled),
        categories: toCategories(news.liveTrace.categories),
      };
    }
  }
  if (
    news.resourceLogCategories !== undefined &&
    categoriesKey(news.resourceLogCategories) !==
      categoriesKey(observed.resourceLogConfiguration?.categories)
  ) {
    delta.resourceLogConfiguration = {
      categories: toCategories(news.resourceLogCategories),
    };
  }
  if (
    news.networkAcls !== undefined &&
    networkAclsKey(news.networkAcls) !==
      networkAclsKey(observed.networkACLs ?? {})
  ) {
    delta.networkACLs = news.networkAcls;
  }
  if (
    news.publicNetworkAccess !== undefined &&
    enabledString(news.publicNetworkAccess) !==
      (observed.publicNetworkAccess ?? "Enabled")
  ) {
    delta.publicNetworkAccess = enabledString(news.publicNetworkAccess);
  }
  if (
    news.disableLocalAuth !== undefined &&
    news.disableLocalAuth !== (observed.disableLocalAuth ?? false)
  ) {
    delta.disableLocalAuth = news.disableLocalAuth;
  }
  if (
    news.disableAadAuth !== undefined &&
    news.disableAadAuth !== (observed.disableAadAuth ?? false)
  ) {
    delta.disableAadAuth = news.disableAadAuth;
  }
  if (
    news.regionEndpointEnabled !== undefined &&
    lower(enabledString(news.regionEndpointEnabled)) !==
      lower(observed.regionEndpointEnabled ?? "Enabled")
  ) {
    delta.regionEndpointEnabled = enabledString(news.regionEndpointEnabled);
  }
  if (
    news.resourceStopped !== undefined &&
    boolString(news.resourceStopped) !==
      lower(observed.resourceStopped ?? "false")
  ) {
    delta.resourceStopped = boolString(news.resourceStopped);
  }
  return delta;
};

const identityDelta = (
  desired: SignalRIdentity | undefined,
  observed: signalr.ManagedIdentity | undefined,
): signalr.ManagedIdentityInput | undefined => {
  if (desired === undefined) return undefined;
  const desiredIds = desired.userAssignedIdentities ?? [];
  if (
    lower(desired.type) === lower(observed?.type ?? "None") &&
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

export const SignalRProvider = () =>
  Provider.succeed(SignalR, {
    stables: [
      "signalRName",
      "signalRId",
      "resourceGroup",
      "location",
      "kind",
      "hostName",
      "endpoint",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* signalr
        .ListSignalRBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListSignalRBySubscription", page),
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
        (news.name !== undefined &&
          lower(news.name) !== lower(output.signalRName)) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        lower(news.kind ?? "SignalR") !== lower(output.kind)
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
        output?.signalRName ?? olds?.name ?? (yield* createSignalRName(id));
      const observed = yield* getSignalR(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const keys = yield* readKeys(
        subscriptionId,
        resourceGroup,
        name,
        observed,
      );
      const attrs = toAttrs(resourceGroup, name, observed, keys);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, SIGNALR_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.signalRName ?? (yield* createSignalRName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const sku = news.sku ?? "Free_F1";
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        resourceName: name,
      };
      const get = getSignalR(subscriptionId, resourceGroup, name);
      const label = `signalr ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation (1-3 minutes).
      if (observed === undefined) {
        const properties = propertyDelta(news, {});
        yield* signalr
          .SignalRCreateOrUpdate({
            ...where,
            location,
            kind: news.kind ?? "SignalR",
            sku: { name: sku, capacity: news.capacity },
            tags,
            identity: identityDelta(news.identity, undefined),
            properties:
              Object.keys(properties).length > 0 ? properties : undefined,
          })
          .pipe(Effect.retry(whileSignalRBusy));
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (s) => s.properties?.provisioningState,
        WAIT,
      );

      // Sync mutable aspects against the observed service; PATCH only deltas.
      const delta = propertyDelta(news, observed.properties ?? {});
      const identity = identityDelta(news.identity, observed.identity);
      const skuChanged =
        lower(observed.sku?.name) !== lower(sku) ||
        (news.capacity !== undefined &&
          news.capacity !== observed.sku?.capacity);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (
        Object.keys(delta).length > 0 ||
        identity !== undefined ||
        skuChanged ||
        tagsChanged
      ) {
        yield* signalr
          .UpdateSignalR({
            ...where,
            location: observed.location,
            sku: skuChanged
              ? { name: sku, capacity: news.capacity }
              : undefined,
            properties: Object.keys(delta).length > 0 ? delta : undefined,
            identity,
            tags: tagsChanged ? tags : undefined,
          })
          .pipe(Effect.retry(whileSignalRBusy));
        observed = yield* waitForProvisioned(
          label,
          get,
          // The PATCH returns before the GET reports `Updating`; keep
          // polling until the desired SKU and properties are visible.
          (s) => {
            const state = s.properties?.provisioningState;
            if (state !== "Succeeded") return state;
            const pending =
              Object.keys(propertyDelta(news, s.properties ?? {})).length > 0 ||
              lower(s.sku?.name) !== lower(sku) ||
              tagsDiffer(s.tags, tags);
            return pending ? "Updating" : state;
          },
          WAIT,
        );
      }

      const keys = yield* readKeys(
        subscriptionId,
        resourceGroup,
        name,
        observed,
      );
      return toAttrs(resourceGroup, name, observed, keys);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        signalr
          .DeleteSignalR({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            resourceName: output.signalRName,
          })
          .pipe(Effect.retry(whileSignalRBusy)),
      );
      yield* waitUntilGone(
        `signalr ${output.signalRName}`,
        getSignalR(subscriptionId, output.resourceGroup, output.signalRName),
        { interval: "5 seconds", times: 90 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
