import * as relay from "@distilled.cloud/azure/relay";
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
  createEntityName,
  hasMarker,
  metadataWithMarker,
  ownershipMarker,
  sameName,
  stripMarker,
} from "./internal.ts";

export interface HybridConnectionProps {
  /** Resource group of the namespace. Changing it replaces the connection. */
  resourceGroup: string;
  /** Relay namespace that holds the connection. Changing it replaces the connection. */
  namespace: string;
  /**
   * Hybrid connection name: 1-260 letters, digits, `.`, `-`, `_`, and `/`,
   * starting and ending with a letter or digit. If omitted, a unique
   * lowercase name is generated from the app, stage, and logical ID.
   * Changing it replaces the connection.
   */
  name?: string;
  /**
   * Whether senders must present a SAS token. Fixed at creation; changing it
   * replaces the connection.
   * @default true
   */
  requiresClientAuthorization?: boolean;
  /**
   * Free-form user metadata (e.g. owner contact). Alchemy appends an
   * ownership marker to the stored value.
   */
  userMetadata?: string;
}

export interface HybridConnection extends Resource<
  "Azure.Relay.HybridConnection",
  HybridConnectionProps,
  {
    /** Name of the hybrid connection. */
    hybridConnectionName: string;
    /** ARM resource ID of the hybrid connection. */
    hybridConnectionId: string;
    /** Namespace that holds the connection. */
    namespaceName: string;
    /** Resource group of the namespace. */
    resourceGroup: string;
    /** Relay endpoint, `sb://<namespace>.servicebus.windows.net/<name>`. */
    endpoint: string;
    /** Whether senders must present a SAS token. */
    requiresClientAuthorization: boolean;
    /** Number of active listeners. */
    listenerCount: number | undefined;
    /** User metadata (Alchemy ownership marker stripped). */
    userMetadata: string | undefined;
    /** Creation time. */
    createdAt: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure Relay Hybrid Connection — a bidirectional WebSocket / HTTP
 * rendezvous point that lets cloud clients reach a listener running behind
 * a firewall (on-premises or in another network) without opening inbound
 * ports. Billing is per active listener; an unused connection is free.
 *
 * Hybrid connections have no tags, so Alchemy records ownership as a
 * `[alchemy <stack>/<stage>/<id>]` marker at the end of `userMetadata`.
 *
 * @see https://learn.microsoft.com/azure/azure-relay/relay-hybrid-connections-protocol
 *
 * ### Creating a Hybrid Connection
 * **Example:** Authenticated hybrid connection
 * ```typescript
 * const ns = yield* Azure.Relay.Namespace("relay", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const hc = yield* Azure.Relay.HybridConnection("onprem-api", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: ns.namespaceName,
 *   userMetadata: "on-prem inventory API",
 * });
 * ```
 *
 * **Example:** Anonymous senders
 * ```typescript
 * const hc = yield* Azure.Relay.HybridConnection("public-hook", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: ns.namespaceName,
 *   requiresClientAuthorization: false,
 * });
 * ```
 *
 * @resource
 */
export const HybridConnection = Resource<HybridConnection>(
  "Azure.Relay.HybridConnection",
);

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  namespaceName: string;
  hybridConnectionName: string;
}

const getConnection = (where: Where) =>
  orUndefinedIfNotFound(relay.GetHybridConnection(where));

const toAttrs = (
  where: Where,
  observed: relay.GetHybridConnectionResponse,
): HybridConnection["Attributes"] => ({
  hybridConnectionName: where.hybridConnectionName,
  hybridConnectionId: observed.id ?? "",
  namespaceName: where.namespaceName,
  resourceGroup: where.resourceGroupName,
  endpoint: `sb://${where.namespaceName}.servicebus.windows.net/${where.hybridConnectionName}`,
  requiresClientAuthorization:
    observed.properties?.requiresClientAuthorization ?? true,
  listenerCount: observed.properties?.listenerCount,
  userMetadata: stripMarker(observed.properties?.userMetadata),
  createdAt: observed.properties?.createdAt,
});

export const HybridConnectionProvider = () =>
  Provider.succeed(HybridConnection, {
    stables: [
      "hybridConnectionName",
      "hybridConnectionId",
      "namespaceName",
      "resourceGroup",
      "endpoint",
    ],

    // Hybrid connections live inside a namespace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.namespace, output.namespaceName) ||
        (news.name !== undefined &&
          !sameName(news.name, output.hybridConnectionName)) ||
        (news.requiresClientAuthorization ?? true) !==
          output.requiresClientAuthorization
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroupName = output?.resourceGroup ?? olds?.resourceGroup;
      const namespaceName = output?.namespaceName ?? olds?.namespace;
      if (resourceGroupName === undefined || namespaceName === undefined) {
        return undefined;
      }
      const where = {
        subscriptionId,
        resourceGroupName,
        namespaceName,
        hybridConnectionName:
          output?.hybridConnectionName ??
          olds?.name ??
          (yield* createEntityName(id, 260)),
      };
      const observed = yield* getConnection(where);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(where, observed);
      return (yield* hasMarker(id, observed.properties?.userMetadata))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Relay");
      const where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        namespaceName: news.namespace,
        hybridConnectionName:
          news.name ??
          output?.hybridConnectionName ??
          (yield* createEntityName(id, 260)),
      };
      const userMetadata = metadataWithMarker(
        news.userMetadata,
        yield* ownershipMarker(id),
      );
      const requiresClientAuthorization =
        news.requiresClientAuthorization ?? true;

      // Observe.
      const observed = yield* getConnection(where);

      // Ensure + sync. `requiresClientAuthorization` is immutable (diff
      // replaces on change), so only metadata can drift in place.
      if (
        observed === undefined ||
        observed.properties?.userMetadata !== userMetadata
      ) {
        yield* relay.HybridConnectionsCreateOrUpdate({
          ...where,
          properties: { requiresClientAuthorization, userMetadata },
        });
      }

      const fresh = yield* waitForProvisioned(
        `relay hybrid connection ${where.hybridConnectionName}`,
        getConnection(where),
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(where, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        namespaceName: output.namespaceName,
        hybridConnectionName: output.hybridConnectionName,
      };
      yield* ignoreNotFound(relay.DeleteHybridConnection(where));
      yield* waitUntilGone(
        `relay hybrid connection ${output.hybridConnectionName}`,
        getConnection(where),
      );
    }),

    nuke: { dependsOn: ["Azure.Relay.Namespace"] },
  });
