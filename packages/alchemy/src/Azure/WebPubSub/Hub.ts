import * as webpubsub from "@distilled.cloud/azure/webpubsub";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createHubName,
  lower,
  WEBPUBSUB_NAMESPACE,
  webPubSubOwnedByStage,
  whileWebPubSubBusy,
} from "./internal.ts";

export interface HubEventHandler {
  /**
   * Upstream URL template. `{hub}` and `{event}` are substituted per
   * request, e.g. `https://example.com/api/{hub}/{event}`. The host part
   * cannot contain parameters.
   */
  urlTemplate: string;
  /**
   * User events forwarded to the handler: `*` for all, `event1,event2`,
   * or a single event name.
   */
  userEventPattern?: string;
  /** System events forwarded to the handler: `connect`, `connected`, `disconnected`. */
  systemEvents?: string[];
  /**
   * Authenticate upstream calls with the service's managed identity,
   * requesting a token for this App ID URI (the `aud` claim). The service
   * needs an identity.
   */
  managedIdentityResource?: string;
}

export interface HubEventListener {
  /** System events forwarded to the listener: `connected`, `disconnected`. */
  systemEvents?: string[];
  /**
   * User events forwarded to the listener: `*` for all, `event1,event2`,
   * or a single event name.
   */
  userEventPattern?: string;
  /** Fully qualified Event Hubs namespace, e.g. `my-ns.servicebus.windows.net`. */
  eventHubNamespace: string;
  /** Event hub that receives the events. */
  eventHubName: string;
}

export interface HubProps {
  /** Resource group of the Web PubSub service. Changing it replaces the hub. */
  resourceGroup: string;
  /** Web PubSub service that owns the hub. Changing it replaces the hub. */
  webPubSub: string;
  /**
   * Hub name: letters, digits, and underscores, starting with a letter. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the hub.
   */
  name?: string;
  /** Upstream webhooks invoked for client events, in priority order. */
  eventHandlers?: HubEventHandler[];
  /**
   * Event Hubs listeners that receive client events (at most 10 across all
   * hubs of a service). The service's identity needs the `Azure Event Hubs
   * Data Sender` role on the event hub.
   */
  eventListeners?: HubEventListener[];
  /**
   * Whether clients may connect without an access token.
   * @default "deny"
   */
  anonymousConnectPolicy?: "allow" | "deny";
  /**
   * WebSocket ping interval in seconds (1-120).
   * @default 20
   */
  webSocketKeepAliveIntervalInSeconds?: number;
}

export interface Hub extends Resource<
  "Azure.WebPubSub.Hub",
  HubProps,
  {
    /** Name of the hub. */
    hubName: string;
    /** ARM resource ID of the hub. */
    hubId: string;
    /** Web PubSub service that owns the hub. */
    webPubSub: string;
    /** Resource group of the Web PubSub service. */
    resourceGroup: string;
    /** Anonymous connect policy as reported by Azure. */
    anonymousConnectPolicy: string;
    /** WebSocket keep-alive interval in seconds. */
    webSocketKeepAliveIntervalInSeconds: number;
  },
  never,
  Providers
> {}

/**
 * A hub of an Azure Web PubSub service: a logical channel with its own
 * upstream event handlers, Event Hubs listeners, and anonymous-connect
 * policy. Clients connect to `wss://{host}/client/hubs/{hubName}`.
 *
 * @see https://learn.microsoft.com/azure/azure-web-pubsub/howto-develop-eventhandler
 *
 * ### Creating a Hub
 * **Example:** Hub with an upstream webhook
 * ```typescript
 * const pubsub = yield* Azure.WebPubSub.WebPubSub("pubsub", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const hub = yield* Azure.WebPubSub.Hub("chat", {
 *   resourceGroup: group.resourceGroupName,
 *   webPubSub: pubsub.webPubSubName,
 *   name: "chat",
 *   eventHandlers: [
 *     {
 *       urlTemplate: "https://example.com/api/{hub}/{event}",
 *       userEventPattern: "*",
 *       systemEvents: ["connect", "connected", "disconnected"],
 *     },
 *   ],
 * });
 * ```
 *
 * ### Forwarding Events to Event Hubs
 * **Example:** Event listener with managed identity
 * ```typescript
 * const hub = yield* Azure.WebPubSub.Hub("events", {
 *   resourceGroup: group.resourceGroupName,
 *   webPubSub: pubsub.webPubSubName,
 *   eventListeners: [
 *     {
 *       userEventPattern: "*",
 *       systemEvents: ["connected", "disconnected"],
 *       eventHubNamespace: "my-ns.servicebus.windows.net",
 *       eventHubName: "pubsub-events",
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const Hub = Resource<Hub>("Azure.WebPubSub.Hub");

const getHub = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
  hubName: string,
) =>
  orUndefinedIfNotFound(
    webpubsub.GetWebPubSubHub({
      subscriptionId,
      resourceGroupName,
      resourceName,
      hubName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  webPubSub: string,
  name: string,
  hub: webpubsub.GetWebPubSubHubResponse,
): Hub["Attributes"] => ({
  hubName: name,
  hubId: hub.id ?? "",
  webPubSub,
  resourceGroup,
  anonymousConnectPolicy: hub.properties.anonymousConnectPolicy ?? "deny",
  webSocketKeepAliveIntervalInSeconds:
    hub.properties.webSocketKeepAliveIntervalInSeconds ?? 20,
});

const desiredProperties = (
  news: HubProps,
): webpubsub.WebPubSubHubProperties => ({
  eventHandlers: (news.eventHandlers ?? []).map((handler) => ({
    urlTemplate: handler.urlTemplate,
    userEventPattern: handler.userEventPattern,
    systemEvents: handler.systemEvents,
    auth:
      handler.managedIdentityResource !== undefined
        ? {
            type: "ManagedIdentity",
            managedIdentity: { resource: handler.managedIdentityResource },
          }
        : undefined,
  })),
  eventListeners: (news.eventListeners ?? []).map((listener) => ({
    filter: {
      type: "EventName",
      systemEvents: listener.systemEvents,
      userEventPattern: listener.userEventPattern,
    },
    endpoint: {
      type: "EventHub",
      fullyQualifiedNamespace: listener.eventHubNamespace,
      eventHubName: listener.eventHubName,
    },
  })),
  anonymousConnectPolicy: news.anonymousConnectPolicy ?? "deny",
  webSocketKeepAliveIntervalInSeconds:
    news.webSocketKeepAliveIntervalInSeconds ?? 20,
});

const events = (values: readonly string[] | undefined) =>
  (values ?? []).map((v) => v.toLowerCase()).sort();

/** Canonical form of hub properties for observed-vs-desired comparison. */
const canonical = (properties: webpubsub.WebPubSubHubProperties) =>
  JSON.stringify({
    handlers: (properties.eventHandlers ?? []).map((h) => [
      h.urlTemplate,
      h.userEventPattern ?? "",
      events(h.systemEvents),
      lower(h.auth?.type ?? "None") === "managedidentity"
        ? (h.auth?.managedIdentity?.resource ?? "")
        : "",
    ]),
    listeners: (properties.eventListeners ?? [])
      .map((l) =>
        JSON.stringify([
          events(l.filter.systemEvents),
          l.filter.userEventPattern ?? "",
          lower(l.endpoint.fullyQualifiedNamespace),
          l.endpoint.eventHubName ?? "",
        ]),
      )
      .sort(),
    anonymous: lower(properties.anonymousConnectPolicy ?? "deny"),
    keepAlive: properties.webSocketKeepAliveIntervalInSeconds ?? 20,
  });

export const HubProvider = () =>
  Provider.succeed(Hub, {
    stables: ["hubName", "hubId", "webPubSub", "resourceGroup"],

    // Hubs live inside a Web PubSub service; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.webPubSub) !== lower(output.webPubSub) ||
        (news.name !== undefined && news.name !== output.hubName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const webPubSub = output?.webPubSub ?? olds?.webPubSub;
      if (resourceGroup === undefined || webPubSub === undefined) {
        return undefined;
      }
      const name = output?.hubName ?? olds?.name ?? (yield* createHubName(id));
      const observed = yield* getHub(
        subscriptionId,
        resourceGroup,
        webPubSub,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, webPubSub, name, observed);
      return (yield* webPubSubOwnedByStage(
        subscriptionId,
        resourceGroup,
        webPubSub,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, WEBPUBSUB_NAMESPACE);
      const { resourceGroup, webPubSub } = news;
      const name = news.name ?? output?.hubName ?? (yield* createHubName(id));
      const get = getHub(subscriptionId, resourceGroup, webPubSub, name);
      const desired = desiredProperties(news);
      const want = canonical(desired);

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the PUT is a full upsert of the hub's properties.
      if (observed === undefined || canonical(observed.properties) !== want) {
        yield* webpubsub
          .WebPubSubHubsCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            resourceName: webPubSub,
            hubName: name,
            properties: desired,
          })
          .pipe(Effect.retry(whileWebPubSubBusy));
      }

      // The PUT is asynchronous; wait until the GET reflects it.
      const fresh = yield* waitForProvisioned(
        `web pubsub hub ${name}`,
        get,
        (hub) =>
          canonical(hub.properties) === want ? "Succeeded" : "Updating",
        { interval: "3 seconds", times: 40 },
      );
      return toAttrs(resourceGroup, webPubSub, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        webpubsub
          .DeleteWebPubSubHub({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            resourceName: output.webPubSub,
            hubName: output.hubName,
          })
          .pipe(Effect.retry(whileWebPubSubBusy)),
      );
      yield* waitUntilGone(
        `web pubsub hub ${output.hubName}`,
        getHub(
          subscriptionId,
          output.resourceGroup,
          output.webPubSub,
          output.hubName,
        ),
        { interval: "3 seconds", times: 40 },
      );
    }),
  });
