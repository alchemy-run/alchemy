import * as webpubsub from "@distilled.cloud/azure/webpubsub";
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
  createWebPubSubName,
  enabledString,
  getWebPubSub,
  lower,
  sameLocation,
  WEBPUBSUB_NAMESPACE,
  whileWebPubSubBusy,
} from "./internal.ts";

export type WebPubSubSkuName =
  | "Free_F1"
  | "Standard_S1"
  | "Premium_P1"
  | "Premium_P2";
export type WebPubSubKind = "WebPubSub" | "SocketIO";
export type WebPubSubRequestType =
  | "ClientConnection"
  | "ServerConnection"
  | "RESTAPI"
  | "Trace";

export interface WebPubSubLogCategory {
  /** Category name: `ConnectivityLogs`, `MessagingLogs`, or `HttpRequestLogs`. */
  name: string;
  /** Whether the category is collected. */
  enabled: boolean;
}

export interface WebPubSubLiveTrace {
  /** Whether live trace clients may connect to the service. */
  enabled: boolean;
  /** Per-category live trace switches. */
  categories?: WebPubSubLogCategory[];
}

export interface WebPubSubNetworkAcl {
  /** Request types allowed through this ACL. */
  allow?: WebPubSubRequestType[];
  /** Request types denied by this ACL. */
  deny?: WebPubSubRequestType[];
}

export interface WebPubSubPrivateEndpointAcl extends WebPubSubNetworkAcl {
  /** Name of the private endpoint connection the ACL applies to. */
  name: string;
}

export interface WebPubSubIpRule {
  /** IP address, CIDR range, or service tag. */
  value: string;
  /** Whether matching traffic is allowed or denied. */
  action: "Allow" | "Deny";
}

export interface WebPubSubNetworkAcls {
  /** Action applied to requests no ACL matches. */
  defaultAction: "Allow" | "Deny";
  /** ACL for requests from the public network. */
  publicNetwork?: WebPubSubNetworkAcl;
  /** ACLs for requests from private endpoints. */
  privateEndpoints?: WebPubSubPrivateEndpointAcl[];
  /** IP rules filtering public traffic. */
  ipRules?: WebPubSubIpRule[];
}

export interface WebPubSubIdentity {
  /** Identity type. `None` removes the identity. */
  type: "None" | "SystemAssigned" | "UserAssigned";
  /** ARM resource IDs of user-assigned identities (with `UserAssigned`). */
  userAssignedIdentities?: string[];
}

export interface WebPubSubProps {
  /** Resource group the service is created in. Changing it replaces the service. */
  resourceGroup: string;
  /**
   * Globally unique service name (it becomes
   * `{name}.webpubsub.azure.com`): 3-63 letters, digits, and hyphens,
   * starting with a letter. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the service.
   */
  name?: string;
  /**
   * Azure location of the service. Changing it replaces the service.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * `WebPubSub` for the native Web PubSub protocol, or `SocketIO` for Web
   * PubSub for Socket.IO. Changing it replaces the service.
   * @default "WebPubSub"
   */
  kind?: WebPubSubKind;
  /**
   * Pricing tier. A subscription may hold one `Free_F1` service per
   * region. Replicas need `Premium_P1` or `Premium_P2`.
   * @default "Free_F1"
   */
  sku?: WebPubSubSkuName;
  /**
   * Unit count: `1` for `Free_F1`; 1-10, 20, 30, ..., 100 for `Standard_S1`
   * and `Premium_P1`; 100, 200, ..., 1000 for `Premium_P2`.
   * @default Azure's default for the tier
   */
  capacity?: number;
  /**
   * Request a client certificate during the TLS handshake. Ignored on
   * `Free_F1`.
   * @default Azure's default (`false`)
   */
  clientCertEnabled?: boolean;
  /** Live trace settings. */
  liveTrace?: WebPubSubLiveTrace;
  /** Resource log categories sent to diagnostic settings. */
  resourceLogCategories?: WebPubSubLogCategory[];
  /** Network ACLs for public and private endpoint traffic. */
  networkAcls?: WebPubSubNetworkAcls;
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
  /**
   * Socket.IO service mode (only with `kind: "SocketIO"`): `Default` with
   * your own Socket.IO server, or `Serverless`.
   * @default Azure's default (`Default`)
   */
  socketIOServiceMode?: "Default" | "Serverless";
  /** Managed identity of the service, e.g. for event handler auth. */
  identity?: WebPubSubIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface WebPubSub extends Resource<
  "Azure.WebPubSub.WebPubSub",
  WebPubSubProps,
  {
    /** Name of the Web PubSub service. */
    webPubSubName: string;
    /** ARM resource ID of the service; use it as a role-assignment scope. */
    webPubSubId: string;
    /** Resource group that holds the service. */
    resourceGroup: string;
    /** Location of the service. */
    location: string;
    /** Service kind (`WebPubSub` or `SocketIO`). */
    kind: string;
    /** Pricing tier. */
    sku: string;
    /** Unit count. */
    capacity: number | undefined;
    /** Service FQDN, e.g. `{name}.webpubsub.azure.com`. */
    hostName: string;
    /** HTTPS endpoint of the data plane, e.g. `https://{name}.webpubsub.azure.com`. */
    endpoint: string;
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
 * An Azure Web PubSub service — a managed real-time messaging service for
 * WebSocket and Socket.IO clients. Configure hubs with
 * `Azure.WebPubSub.Hub`; the access keys and connection strings are exposed
 * as redacted attributes.
 *
 * @see https://learn.microsoft.com/azure/azure-web-pubsub/overview
 *
 * ### Creating a Service
 * **Example:** Free tier service
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const pubsub = yield* Azure.WebPubSub.WebPubSub("pubsub", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Standard tier with two units and live trace
 * ```typescript
 * const pubsub = yield* Azure.WebPubSub.WebPubSub("pubsub", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Standard_S1",
 *   capacity: 2,
 *   liveTrace: {
 *     enabled: true,
 *     categories: [{ name: "ConnectivityLogs", enabled: true }],
 *   },
 * });
 * ```
 *
 * ### Socket.IO
 * **Example:** Serverless Web PubSub for Socket.IO
 * ```typescript
 * const io = yield* Azure.WebPubSub.WebPubSub("socketio", {
 *   resourceGroup: group.resourceGroupName,
 *   kind: "SocketIO",
 *   sku: "Standard_S1",
 *   socketIOServiceMode: "Serverless",
 * });
 * ```
 *
 * ### Securing the Service
 * **Example:** Entra ID only, with a system-assigned identity
 * ```typescript
 * const pubsub = yield* Azure.WebPubSub.WebPubSub("pubsub", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Standard_S1",
 *   disableLocalAuth: true,
 *   identity: { type: "SystemAssigned" },
 * });
 * ```
 *
 * @resource
 */
export const WebPubSub = Resource<WebPubSub>("Azure.WebPubSub.WebPubSub");

type Observed = webpubsub.GetWebPubSubResponse | webpubsub.WebPubSubResource;

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
): WebPubSub["Attributes"] => {
  const hostName =
    service.properties?.hostName ?? `${name}.webpubsub.azure.com`;
  return {
    webPubSubName: name,
    webPubSubId: service.id ?? "",
    resourceGroup,
    location: service.location,
    kind: service.kind ?? "WebPubSub",
    sku: service.sku?.name ?? "",
    capacity: service.sku?.capacity,
    hostName,
    endpoint: `https://${hostName}`,
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
  const keys = yield* webpubsub.ListWebPubSubKeys({
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

const categoriesKey = (
  categories:
    | readonly { name?: string; enabled?: string | boolean }[]
    | undefined,
) =>
  (categories ?? [])
    .map((c) => `${lower(c.name)}=${lower(String(c.enabled ?? "false"))}`)
    .sort()
    .join(",");

const sortedJoin = (values: readonly (string | undefined)[] | undefined) =>
  (values ?? [])
    .flatMap((v) => (v === undefined ? [] : [v.toLowerCase()]))
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

const toCategories = (categories: WebPubSubLogCategory[] | undefined) =>
  categories?.map((c) => ({ name: c.name, enabled: boolString(c.enabled) }));

/** Mutable properties whose observed value differs from the desired value. */
const propertyDelta = (
  news: WebPubSubProps,
  observed: webpubsub.WebPubSubProperties,
): webpubsub.WebPubSubPropertiesInput => {
  const delta: webpubsub.WebPubSubPropertiesInput = {};
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
    enabledString(news.regionEndpointEnabled) !==
      (observed.regionEndpointEnabled ?? "Enabled")
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
  if (
    news.socketIOServiceMode !== undefined &&
    lower(news.socketIOServiceMode) !==
      lower(observed.socketIO?.serviceMode ?? "Default")
  ) {
    delta.socketIO = { serviceMode: news.socketIOServiceMode };
  }
  return delta;
};

const identityDelta = (
  desired: WebPubSubIdentity | undefined,
  observed: webpubsub.ManagedIdentity | undefined,
): webpubsub.ManagedIdentityInput | undefined => {
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

const WAIT = { interval: "10 seconds", times: 60 } as const;

export const WebPubSubProvider = () =>
  Provider.succeed(WebPubSub, {
    stables: [
      "webPubSubName",
      "webPubSubId",
      "resourceGroup",
      "location",
      "kind",
      "hostName",
      "endpoint",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* webpubsub
        .ListWebPubSubBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListWebPubSubBySubscription", page),
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
          lower(news.name) !== lower(output.webPubSubName)) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        lower(news.kind ?? "WebPubSub") !== lower(output.kind)
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
        output?.webPubSubName ?? olds?.name ?? (yield* createWebPubSubName(id));
      const observed = yield* getWebPubSub(subscriptionId, resourceGroup, name);
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
      yield* ensureRegistered(subscriptionId, WEBPUBSUB_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.webPubSubName ?? (yield* createWebPubSubName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const sku = news.sku ?? "Free_F1";
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        resourceName: name,
      };
      const get = getWebPubSub(subscriptionId, resourceGroup, name);
      const label = `web pubsub ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation (1-3 minutes).
      if (observed === undefined) {
        yield* webpubsub
          .WebPubSubCreateOrUpdate({
            ...where,
            location,
            kind: news.kind ?? "WebPubSub",
            sku: { name: sku, capacity: news.capacity },
            tags,
            identity: identityDelta(news.identity, undefined),
            properties: propertyDelta(news, {}),
          })
          .pipe(Effect.retry(whileWebPubSubBusy));
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
        yield* webpubsub
          .UpdateWebPubSub({
            ...where,
            location: observed.location,
            sku: skuChanged
              ? { name: sku, capacity: news.capacity }
              : undefined,
            properties: Object.keys(delta).length > 0 ? delta : undefined,
            identity,
            tags: tagsChanged ? tags : undefined,
          })
          .pipe(Effect.retry(whileWebPubSubBusy));
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
        webpubsub
          .DeleteWebPubSub({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            resourceName: output.webPubSubName,
          })
          .pipe(Effect.retry(whileWebPubSubBusy)),
      );
      yield* waitUntilGone(
        `web pubsub ${output.webPubSubName}`,
        getWebPubSub(
          subscriptionId,
          output.resourceGroup,
          output.webPubSubName,
        ),
        { interval: "5 seconds", times: 90 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
