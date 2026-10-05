import * as signalr from "@distilled.cloud/azure/signalr";
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
  createSignalRName,
  lower,
  sharedPrivateLinkMatches,
  sharedPrivateLinkTargetChanged,
  SIGNALR_NAMESPACE,
  signalROwnedByStage,
  WAIT,
  whileSignalRBusy,
} from "./internal.ts";

export interface SharedPrivateLinkResourceProps {
  /** Resource group of the SignalR service. Changing it replaces the link. */
  resourceGroup: string;
  /**
   * SignalR service that makes outbound calls over the link. Needs the
   * `Standard_S1` tier or higher. Changing it replaces the link.
   */
  signalR: string;
  /**
   * Name of the shared private link resource. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * link.
   */
  name?: string;
  /**
   * Private link sub-resource (group ID) of the target, e.g. `sites` for a
   * Function App, `vault` for a Key Vault. Changing it replaces the link.
   */
  groupId: string;
  /** ARM resource ID of the target resource. Changing it replaces the link. */
  privateLinkResourceId: string;
  /**
   * Message shown to the target's owner when approving the connection.
   * Changing it replaces the link.
   */
  requestMessage?: string;
}

export interface SharedPrivateLinkResource extends Resource<
  "Azure.SignalR.SharedPrivateLinkResource",
  SharedPrivateLinkResourceProps,
  {
    /** Name of the shared private link resource. */
    sharedPrivateLinkResourceName: string;
    /** ARM resource ID of the shared private link resource. */
    sharedPrivateLinkResourceId: string;
    /** SignalR service that owns the link. */
    signalR: string;
    /** Resource group of the SignalR service. */
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
 * A shared private link resource of an Azure SignalR Service: a managed
 * private endpoint the service uses for outbound calls (serverless
 * upstreams, Key Vault certificate references) to a private target such as
 * a Function App. The target's owner must approve the resulting private
 * endpoint connection before traffic flows; until then `status` is
 * `Pending`.
 *
 * @see https://learn.microsoft.com/azure/azure-signalr/howto-shared-private-endpoints
 *
 * ### Reaching a Private Target
 * **Example:** Private link to a Function App
 * ```typescript
 * const signalR = yield* Azure.SignalR.SignalR("realtime", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Standard_S1",
 *   serviceMode: "Serverless",
 * });
 * const link = yield* Azure.SignalR.SharedPrivateLinkResource("func", {
 *   resourceGroup: group.resourceGroupName,
 *   signalR: signalR.signalRName,
 *   groupId: "sites",
 *   privateLinkResourceId: functionApp.siteId,
 *   requestMessage: "SignalR upstream",
 * });
 * ```
 *
 * **Example:** Private link to a Key Vault
 * ```typescript
 * const link = yield* Azure.SignalR.SharedPrivateLinkResource("vault", {
 *   resourceGroup: group.resourceGroupName,
 *   signalR: signalR.signalRName,
 *   groupId: "vault",
 *   privateLinkResourceId: vault.vaultId,
 * });
 * ```
 *
 * @resource
 */
export const SharedPrivateLinkResource = Resource<SharedPrivateLinkResource>(
  "Azure.SignalR.SharedPrivateLinkResource",
);

const getLink = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
  sharedPrivateLinkResourceName: string,
) =>
  orUndefinedIfNotFound(
    signalr.GetSignalRSharedPrivateLinkResource({
      subscriptionId,
      resourceGroupName,
      resourceName,
      sharedPrivateLinkResourceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  signalR: string,
  name: string,
  link: signalr.GetSignalRSharedPrivateLinkResourceResponse,
): SharedPrivateLinkResource["Attributes"] => ({
  sharedPrivateLinkResourceName: name,
  sharedPrivateLinkResourceId: link.id ?? "",
  signalR,
  resourceGroup,
  groupId: link.properties?.groupId ?? "",
  privateLinkResourceId: link.properties?.privateLinkResourceId ?? "",
  requestMessage: link.properties?.requestMessage,
  status: link.properties?.status,
});

export const SharedPrivateLinkResourceProvider = () =>
  Provider.succeed(SharedPrivateLinkResource, {
    stables: [
      "sharedPrivateLinkResourceName",
      "sharedPrivateLinkResourceId",
      "signalR",
      "resourceGroup",
      "groupId",
      "privateLinkResourceId",
    ],

    // Shared private links are deleted with their SignalR service.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.signalR) !== lower(output.signalR) ||
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
      const signalR = output?.signalR ?? olds?.signalR;
      if (resourceGroup === undefined || signalR === undefined) {
        return undefined;
      }
      const name =
        output?.sharedPrivateLinkResourceName ??
        olds?.name ??
        (yield* createSignalRName(id));
      const observed = yield* getLink(
        subscriptionId,
        resourceGroup,
        signalR,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, signalR, name, observed);
      return (yield* signalROwnedByStage(
        subscriptionId,
        resourceGroup,
        signalR,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, SIGNALR_NAMESPACE);
      const { resourceGroup, signalR } = news;
      const name =
        news.name ??
        output?.sharedPrivateLinkResourceName ??
        (yield* createSignalRName(id));
      const get = getLink(subscriptionId, resourceGroup, signalR, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the PUT is a full upsert; skip it when nothing changed.
      if (!sharedPrivateLinkMatches(news, observed?.properties)) {
        yield* signalr
          .SignalRSharedPrivateLinkResourcesCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            resourceName: signalR,
            sharedPrivateLinkResourceName: name,
            properties: {
              groupId: news.groupId,
              privateLinkResourceId: news.privateLinkResourceId,
              requestMessage: news.requestMessage,
            },
          })
          .pipe(Effect.retry(whileSignalRBusy));
      }

      // The PUT is a long-running operation; wait for the GET to settle
      // with the desired properties.
      const fresh = yield* waitForProvisioned(
        `signalr shared private link ${name}`,
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
      return toAttrs(resourceGroup, signalR, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        signalr
          .DeleteSignalRSharedPrivateLinkResource({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            resourceName: output.signalR,
            sharedPrivateLinkResourceName: output.sharedPrivateLinkResourceName,
          })
          .pipe(Effect.retry(whileSignalRBusy)),
      );
      yield* waitUntilGone(
        `signalr shared private link ${output.sharedPrivateLinkResourceName}`,
        getLink(
          subscriptionId,
          output.resourceGroup,
          output.signalR,
          output.sharedPrivateLinkResourceName,
        ),
        WAIT,
      );
    }),

    nuke: {
      dependsOn: ["Azure.SignalR.SignalR", "Azure.Resources.ResourceGroup"],
    },
  });
