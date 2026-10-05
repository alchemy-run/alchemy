import * as signalr from "@distilled.cloud/azure/signalr";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  orUndefinedIfNotFound,
  waitForProvisioned,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  lower,
  sharedPrivateLinkMatches,
  sharedPrivateLinkTargetChanged,
  SIGNALR_NAMESPACE,
  signalROwnedByStage,
  WAIT,
  whileSignalRBusy,
} from "./internal.ts";

export interface ReplicaSharedPrivateLinkResourceProps {
  /** Resource group of the SignalR service. Changing it replaces the link. */
  resourceGroup: string;
  /** SignalR service that owns the replica. Changing it replaces the link. */
  signalR: string;
  /** Replica the link belongs to. Changing it replaces the link. */
  replica: string;
  /**
   * Name of the primary service's `Azure.SignalR.SharedPrivateLinkResource`.
   * Azure replicates every primary link to each replica under the same
   * name; this resource waits for the copy and converges its settings.
   * Changing it replaces the link.
   */
  sharedPrivateLinkResource: string;
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

export interface ReplicaSharedPrivateLinkResource extends Resource<
  "Azure.SignalR.ReplicaSharedPrivateLinkResource",
  ReplicaSharedPrivateLinkResourceProps,
  {
    /** Name of the shared private link resource. */
    sharedPrivateLinkResourceName: string;
    /** ARM resource ID of the shared private link resource. */
    sharedPrivateLinkResourceId: string;
    /** SignalR service that owns the replica. */
    signalR: string;
    /** Replica that owns the link. */
    replica: string;
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
 * The replica copy of a SignalR shared private link resource. Azure does
 * not create replica links directly: each link of the primary service is
 * replicated to every replica under the same name — but only after the
 * target's owner has approved the primary link — and the replica copy
 * needs its own approval on the target. This resource waits (up to 10
 * minutes) for the copy,
 * keeps its settings converged, and exposes its approval `status`.
 *
 * Azure exposes no DELETE for replica shared private links: destroying this
 * resource only forgets it, and the copy is removed together with the
 * primary link or the replica.
 *
 * @see https://learn.microsoft.com/azure/azure-signalr/howto-enable-geo-replication
 *
 * ### Tracking a Replicated Link
 * **Example:** Primary link and its copy on a replica
 * ```typescript
 * const link = yield* Azure.SignalR.SharedPrivateLinkResource("vault", {
 *   resourceGroup: group.resourceGroupName,
 *   signalR: signalR.signalRName,
 *   groupId: "vault",
 *   privateLinkResourceId: vault.vaultId,
 * });
 * const westLink = yield* Azure.SignalR.ReplicaSharedPrivateLinkResource("vault-west", {
 *   resourceGroup: group.resourceGroupName,
 *   signalR: signalR.signalRName,
 *   replica: replica.replicaName,
 *   sharedPrivateLinkResource: link.sharedPrivateLinkResourceName,
 *   groupId: "vault",
 *   privateLinkResourceId: vault.vaultId,
 * });
 * ```
 *
 * @resource
 */
export const ReplicaSharedPrivateLinkResource =
  Resource<ReplicaSharedPrivateLinkResource>(
    "Azure.SignalR.ReplicaSharedPrivateLinkResource",
  );

const getLink = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
  replicaName: string,
  sharedPrivateLinkResourceName: string,
) =>
  orUndefinedIfNotFound(
    signalr.GetSignalRReplicaSharedPrivateLinkResource({
      subscriptionId,
      resourceGroupName,
      resourceName,
      replicaName,
      sharedPrivateLinkResourceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  signalR: string,
  replica: string,
  name: string,
  link: signalr.GetSignalRReplicaSharedPrivateLinkResourceResponse,
): ReplicaSharedPrivateLinkResource["Attributes"] => ({
  sharedPrivateLinkResourceName: name,
  sharedPrivateLinkResourceId: link.id ?? "",
  signalR,
  replica,
  resourceGroup,
  groupId: link.properties?.groupId ?? "",
  privateLinkResourceId: link.properties?.privateLinkResourceId ?? "",
  requestMessage: link.properties?.requestMessage,
  status: link.properties?.status,
});

export const ReplicaSharedPrivateLinkResourceProvider = () =>
  Provider.succeed(ReplicaSharedPrivateLinkResource, {
    stables: [
      "sharedPrivateLinkResourceName",
      "sharedPrivateLinkResourceId",
      "signalR",
      "replica",
      "resourceGroup",
      "groupId",
      "privateLinkResourceId",
    ],

    // Replica links are copies removed with the primary link or replica.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.signalR) !== lower(output.signalR) ||
        lower(news.replica) !== lower(output.replica) ||
        lower(news.sharedPrivateLinkResource) !==
          lower(output.sharedPrivateLinkResourceName) ||
        sharedPrivateLinkTargetChanged(news, output)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const signalR = output?.signalR ?? olds?.signalR;
      const replica = output?.replica ?? olds?.replica;
      if (
        resourceGroup === undefined ||
        signalR === undefined ||
        replica === undefined
      ) {
        return undefined;
      }
      const name =
        output?.sharedPrivateLinkResourceName ??
        olds?.sharedPrivateLinkResource;
      if (name === undefined) return undefined;
      const observed = yield* getLink(
        subscriptionId,
        resourceGroup,
        signalR,
        replica,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, signalR, replica, name, observed);
      return (yield* signalROwnedByStage(
        subscriptionId,
        resourceGroup,
        signalR,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, SIGNALR_NAMESPACE);
      const { resourceGroup, signalR, replica } = news;
      const name = news.sharedPrivateLinkResource;
      const get = getLink(
        subscriptionId,
        resourceGroup,
        signalR,
        replica,
        name,
      );

      // Observe. The copy appears once the primary link has replicated.
      const observed = yield* waitForProvisioned(
        `signalr replica shared private link ${name}`,
        get,
        (link) => link.properties?.provisioningState,
        WAIT,
      );

      // Ensure + sync: the PUT is a full upsert; skip it when nothing changed.
      if (!sharedPrivateLinkMatches(news, observed.properties)) {
        yield* signalr
          .SignalRReplicaSharedPrivateLinkResourcesCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            resourceName: signalR,
            replicaName: replica,
            sharedPrivateLinkResourceName: name,
            properties: {
              groupId: news.groupId,
              privateLinkResourceId: news.privateLinkResourceId,
              requestMessage: news.requestMessage,
            },
          })
          .pipe(
            Effect.retry({
              ...whileSignalRBusy,
              while: (e) =>
                e._tag === "ResourceConflict" ||
                e._tag === "SignalRReplicaLinkNotReplicated",
            }),
          );
      }

      const fresh = yield* waitForProvisioned(
        `signalr replica shared private link ${name}`,
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
      return toAttrs(resourceGroup, signalR, replica, name, fresh);
    }),

    // Azure has no DELETE for replica shared private links; the copy is
    // removed together with the primary link or the replica.
    delete: Effect.fn(function* () {}),

    nuke: {
      dependsOn: [
        "Azure.SignalR.SharedPrivateLinkResource",
        "Azure.SignalR.Replica",
        "Azure.SignalR.SignalR",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
