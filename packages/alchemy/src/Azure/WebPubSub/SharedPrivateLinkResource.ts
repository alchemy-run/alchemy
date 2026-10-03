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
  createWebPubSubName,
  lower,
  WEBPUBSUB_NAMESPACE,
  webPubSubOwnedByStage,
  whileWebPubSubBusy,
} from "./internal.ts";

export interface SharedPrivateLinkResourceProps {
  /** Resource group of the Web PubSub service. Changing it replaces the link. */
  resourceGroup: string;
  /**
   * Web PubSub service that makes outbound calls over the link. Needs the
   * `Standard_S1` tier or higher. Changing it replaces the link.
   */
  webPubSub: string;
  /**
   * Name of the shared private link resource. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * link.
   */
  name?: string;
  /**
   * Private link sub-resource (group ID) of the target, e.g. `sites` for a
   * Function App, `vault` for a Key Vault, `blob` for a storage account.
   * Changing it replaces the link.
   */
  groupId: string;
  /** ARM resource ID of the target resource. Changing it replaces the link. */
  privateLinkResourceId: string;
  /** Message shown to the target's owner when approving the connection. */
  requestMessage?: string;
}

export interface SharedPrivateLinkResource extends Resource<
  "Azure.WebPubSub.SharedPrivateLinkResource",
  SharedPrivateLinkResourceProps,
  {
    /** Name of the shared private link resource. */
    sharedPrivateLinkResourceName: string;
    /** ARM resource ID of the shared private link resource. */
    sharedPrivateLinkResourceId: string;
    /** Web PubSub service that owns the link. */
    webPubSub: string;
    /** Resource group of the Web PubSub service. */
    resourceGroup: string;
    /** Private link sub-resource (group ID) of the target. */
    groupId: string;
    /** ARM resource ID of the target resource. */
    privateLinkResourceId: string;
    /** Approval message sent to the target's owner. */
    requestMessage: string | undefined;
    /**
     * Connection status: `Pending` until the target's owner approves the
     * private endpoint connection, then `Approved` (or `Rejected`,
     * `Disconnected`, `Timeout`).
     */
    status: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A shared private link resource of an Azure Web PubSub service: a managed
 * private endpoint the service uses for outbound calls (event handlers,
 * Key Vault references) to a private target such as a Function App. The
 * target's owner must approve the resulting private endpoint connection
 * before traffic flows; until then `status` is `Pending`.
 *
 * @see https://learn.microsoft.com/azure/azure-web-pubsub/howto-secure-shared-private-endpoints
 *
 * ### Reaching a Private Target
 * **Example:** Private link to a Function App
 * ```typescript
 * const pubsub = yield* Azure.WebPubSub.WebPubSub("pubsub", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Standard_S1",
 * });
 * const link = yield* Azure.WebPubSub.SharedPrivateLinkResource("func", {
 *   resourceGroup: group.resourceGroupName,
 *   webPubSub: pubsub.webPubSubName,
 *   groupId: "sites",
 *   privateLinkResourceId: functionApp.siteId,
 *   requestMessage: "Web PubSub upstream",
 * });
 * ```
 *
 * **Example:** Private link to a Key Vault
 * ```typescript
 * const link = yield* Azure.WebPubSub.SharedPrivateLinkResource("vault", {
 *   resourceGroup: group.resourceGroupName,
 *   webPubSub: pubsub.webPubSubName,
 *   groupId: "vault",
 *   privateLinkResourceId: vault.vaultId,
 * });
 * ```
 *
 * @resource
 */
export const SharedPrivateLinkResource = Resource<SharedPrivateLinkResource>(
  "Azure.WebPubSub.SharedPrivateLinkResource",
);

const getLink = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
  sharedPrivateLinkResourceName: string,
) =>
  orUndefinedIfNotFound(
    webpubsub.GetWebPubSubSharedPrivateLinkResource({
      subscriptionId,
      resourceGroupName,
      resourceName,
      sharedPrivateLinkResourceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  webPubSub: string,
  name: string,
  link: webpubsub.GetWebPubSubSharedPrivateLinkResourceResponse,
): SharedPrivateLinkResource["Attributes"] => ({
  sharedPrivateLinkResourceName: name,
  sharedPrivateLinkResourceId: link.id ?? "",
  webPubSub,
  resourceGroup,
  groupId: link.properties?.groupId ?? "",
  privateLinkResourceId: link.properties?.privateLinkResourceId ?? "",
  requestMessage: link.properties?.requestMessage,
  status: link.properties?.status,
});

/** Whether the observed link already matches the desired properties. */
export const sharedPrivateLinkMatches = (
  news: {
    groupId: string;
    privateLinkResourceId: string;
    requestMessage?: string;
  },
  observed: webpubsub.SharedPrivateLinkResourceProperties | undefined,
) =>
  observed !== undefined &&
  lower(observed.groupId) === lower(news.groupId) &&
  lower(observed.privateLinkResourceId) ===
    lower(news.privateLinkResourceId) &&
  (news.requestMessage === undefined ||
    observed.requestMessage === news.requestMessage);

/** Whether a change to the link's target requires a new link. */
export const sharedPrivateLinkTargetChanged = (
  news: { groupId: string; privateLinkResourceId: string },
  output: { groupId: string; privateLinkResourceId: string },
) =>
  lower(news.groupId) !== lower(output.groupId) ||
  lower(news.privateLinkResourceId) !== lower(output.privateLinkResourceId);

const WAIT = { interval: "10 seconds", times: 60 } as const;

export const SharedPrivateLinkResourceProvider = () =>
  Provider.succeed(SharedPrivateLinkResource, {
    stables: [
      "sharedPrivateLinkResourceName",
      "sharedPrivateLinkResourceId",
      "webPubSub",
      "resourceGroup",
      "groupId",
      "privateLinkResourceId",
    ],

    // Shared private links are deleted with their Web PubSub service.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.webPubSub) !== lower(output.webPubSub) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.sharedPrivateLinkResourceName)) ||
        sharedPrivateLinkTargetChanged(news, output)
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
      const name =
        output?.sharedPrivateLinkResourceName ??
        olds?.name ??
        (yield* createWebPubSubName(id, 80));
      const observed = yield* getLink(
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
      const name =
        news.name ??
        output?.sharedPrivateLinkResourceName ??
        (yield* createWebPubSubName(id, 80));
      const get = getLink(subscriptionId, resourceGroup, webPubSub, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the PUT is a full upsert; skip it when nothing changed.
      if (!sharedPrivateLinkMatches(news, observed?.properties)) {
        yield* webpubsub
          .WebPubSubSharedPrivateLinkResourcesCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            resourceName: webPubSub,
            sharedPrivateLinkResourceName: name,
            properties: {
              groupId: news.groupId,
              privateLinkResourceId: news.privateLinkResourceId,
              requestMessage: news.requestMessage,
            },
          })
          .pipe(Effect.retry(whileWebPubSubBusy));
      }

      // The PUT is a long-running operation; wait for the GET to settle
      // with the desired properties.
      const fresh = yield* waitForProvisioned(
        `web pubsub shared private link ${name}`,
        get,
        (link) => {
          const state = link.properties?.provisioningState;
          if (state !== undefined && state !== "Succeeded") return state;
          return sharedPrivateLinkMatches(news, link.properties)
            ? "Succeeded"
            : "Updating";
        },
        WAIT,
      );
      return toAttrs(resourceGroup, webPubSub, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        webpubsub
          .DeleteWebPubSubSharedPrivateLinkResource({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            resourceName: output.webPubSub,
            sharedPrivateLinkResourceName: output.sharedPrivateLinkResourceName,
          })
          .pipe(Effect.retry(whileWebPubSubBusy)),
      );
      yield* waitUntilGone(
        `web pubsub shared private link ${output.sharedPrivateLinkResourceName}`,
        getLink(
          subscriptionId,
          output.resourceGroup,
          output.webPubSub,
          output.sharedPrivateLinkResourceName,
        ),
        { interval: "10 seconds", times: 60 },
      );
    }),
  });
