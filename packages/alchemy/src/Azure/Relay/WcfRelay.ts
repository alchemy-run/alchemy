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

export type WcfRelayType = "NetTcp" | "Http";

export interface WcfRelayProps {
  /** Resource group of the namespace. Changing it replaces the relay. */
  resourceGroup: string;
  /** Relay namespace that holds the relay. Changing it replaces the relay. */
  namespace: string;
  /**
   * Relay name: 1-260 letters, digits, `.`, `-`, `_`, and `/`, starting and
   * ending with a letter or digit. If omitted, a unique lowercase name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * relay.
   */
  name?: string;
  /**
   * WCF binding type. Changing it replaces the relay.
   * @default "NetTcp"
   */
  relayType?: WcfRelayType;
  /**
   * Whether senders must present a SAS token. Changing it replaces the
   * relay.
   * @default true
   */
  requiresClientAuthorization?: boolean;
  /**
   * Whether the relay requires transport security (TLS). Changing it
   * replaces the relay.
   * @default true
   */
  requiresTransportSecurity?: boolean;
  /**
   * Free-form user metadata. Alchemy appends an ownership marker to the
   * stored value.
   */
  userMetadata?: string;
}

export interface WcfRelay extends Resource<
  "Azure.Relay.WcfRelay",
  WcfRelayProps,
  {
    /** Name of the relay. */
    relayName: string;
    /** ARM resource ID of the relay. */
    relayId: string;
    /** Namespace that holds the relay. */
    namespaceName: string;
    /** Resource group of the namespace. */
    resourceGroup: string;
    /** Relay endpoint, `sb://<namespace>.servicebus.windows.net/<name>`. */
    endpoint: string;
    /** WCF binding type. */
    relayType: string;
    /** Whether senders must present a SAS token. */
    requiresClientAuthorization: boolean;
    /** Whether transport security is required. */
    requiresTransportSecurity: boolean;
    /** Whether the relay is dynamic (created by a listener, not ARM). */
    isDynamic: boolean | undefined;
    /** Number of active listeners. */
    listenerCount: number | undefined;
    /** User metadata (Alchemy ownership marker stripped). */
    userMetadata: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A persistent Azure Relay WCF relay — a rendezvous endpoint for Windows
 * Communication Foundation services using `NetTcpRelayBinding` or the
 * HTTP relay bindings. WCF Relay is a legacy technology; prefer
 * `HybridConnection` for new workloads. Billing is per relay-hour while a
 * listener is connected.
 *
 * WCF relays have no tags, so Alchemy records ownership as a
 * `[alchemy <stack>/<stage>/<id>]` marker at the end of `userMetadata`.
 *
 * @see https://learn.microsoft.com/azure/azure-relay/relay-wcf-dotnet-get-started
 *
 * ### Creating a WCF Relay
 * **Example:** NetTcp relay
 * ```typescript
 * const ns = yield* Azure.Relay.Namespace("relay", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const svc = yield* Azure.Relay.WcfRelay("legacy-svc", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: ns.namespaceName,
 *   relayType: "NetTcp",
 * });
 * ```
 *
 * **Example:** HTTP relay
 * ```typescript
 * const svc = yield* Azure.Relay.WcfRelay("legacy-http", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: ns.namespaceName,
 *   relayType: "Http",
 *   userMetadata: "SOAP endpoint for ERP",
 * });
 * ```
 *
 * @resource
 */
export const WcfRelay = Resource<WcfRelay>("Azure.Relay.WcfRelay");

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  namespaceName: string;
  relayName: string;
}

const getRelay = (where: Where) =>
  orUndefinedIfNotFound(relay.GetWCFRelay(where));

const toAttrs = (
  where: Where,
  observed: relay.GetWCFRelayResponse,
): WcfRelay["Attributes"] => ({
  relayName: where.relayName,
  relayId: observed.id ?? "",
  namespaceName: where.namespaceName,
  resourceGroup: where.resourceGroupName,
  endpoint: `sb://${where.namespaceName}.servicebus.windows.net/${where.relayName}`,
  relayType: observed.properties?.relayType ?? "NetTcp",
  requiresClientAuthorization:
    observed.properties?.requiresClientAuthorization ?? true,
  requiresTransportSecurity:
    observed.properties?.requiresTransportSecurity ?? true,
  isDynamic: observed.properties?.isDynamic,
  listenerCount: observed.properties?.listenerCount,
  userMetadata: stripMarker(observed.properties?.userMetadata),
});

export const WcfRelayProvider = () =>
  Provider.succeed(WcfRelay, {
    stables: [
      "relayName",
      "relayId",
      "namespaceName",
      "resourceGroup",
      "endpoint",
    ],

    // Relays live inside a namespace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.namespace, output.namespaceName) ||
        (news.name !== undefined && !sameName(news.name, output.relayName)) ||
        !sameName(news.relayType ?? "NetTcp", output.relayType) ||
        (news.requiresClientAuthorization ?? true) !==
          output.requiresClientAuthorization ||
        (news.requiresTransportSecurity ?? true) !==
          output.requiresTransportSecurity
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
        relayName:
          output?.relayName ?? olds?.name ?? (yield* createEntityName(id, 260)),
      };
      const observed = yield* getRelay(where);
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
        relayName:
          news.name ?? output?.relayName ?? (yield* createEntityName(id, 260)),
      };
      const userMetadata = metadataWithMarker(
        news.userMetadata,
        yield* ownershipMarker(id),
      );

      // Observe.
      const observed = yield* getRelay(where);

      // Ensure + sync. Type and security flags are immutable (diff replaces
      // on change), so only metadata can drift in place.
      if (
        observed === undefined ||
        observed.properties?.userMetadata !== userMetadata
      ) {
        yield* relay.WCFRelaysCreateOrUpdate({
          ...where,
          properties: {
            relayType: news.relayType ?? "NetTcp",
            requiresClientAuthorization:
              news.requiresClientAuthorization ?? true,
            requiresTransportSecurity: news.requiresTransportSecurity ?? true,
            userMetadata,
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `relay wcf relay ${where.relayName}`,
        getRelay(where),
        // The PUT is applied asynchronously: a GET right after it can still
        // return the previous metadata, so wait until it converges.
        (wcfRelay) =>
          wcfRelay.properties?.userMetadata === userMetadata
            ? undefined
            : "Updating",
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
        relayName: output.relayName,
      };
      yield* ignoreNotFound(relay.DeleteWCFRelay(where));
      yield* waitUntilGone(
        `relay wcf relay ${output.relayName}`,
        getRelay(where),
      );
    }),

    nuke: { dependsOn: ["Azure.Relay.Namespace"] },
  });
