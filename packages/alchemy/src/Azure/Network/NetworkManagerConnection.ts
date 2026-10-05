import * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  requireSinglePage,
  stackAndStage,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { sameId, waitNetworkGone, whileNetworkBusy } from "./common.ts";
import { networkManagerChildName } from "./networkManagerShared.ts";

export interface NetworkManagerConnectionProps {
  /**
   * Name of the connection. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the connection.
   */
  name?: string;
  /**
   * ARM ID of the network manager (in any tenant) allowed to manage the
   * current subscription. Changing it replaces the connection.
   */
  networkManagerId: string;
  /** Description of the connection. */
  description?: string;
}

export interface NetworkManagerConnection extends Resource<
  "Azure.Network.NetworkManagerConnection",
  NetworkManagerConnectionProps,
  {
    /** Name of the connection. */
    networkManagerConnectionName: string;
    /** ARM resource ID of the connection. */
    networkManagerConnectionId: string;
    /** ARM ID of the connected network manager. */
    networkManagerId: string;
    /** Connection state (`Connected` once the manager has a matching scope connection). */
    connectionState: string | undefined;
    /** Description. */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A subscription-level Azure Virtual Network Manager connection — consent
 * for a network manager (typically in another tenant or scoped to a
 * management group) to manage the current subscription. It pairs with a
 * {@link ScopeConnection} on the manager. Connections are free.
 *
 * Connections carry no tags: ownership is recorded as an
 * `alchemy:<stack>/<stage>/<id>` marker in the description.
 *
 * @see https://learn.microsoft.com/azure/virtual-network-manager/concept-cross-tenant
 *
 * ### Connecting a Network Manager
 * **Example:** Allow a central network manager to manage this subscription
 * ```typescript
 * yield* Azure.Network.NetworkManagerConnection("central", {
 *   networkManagerId: "/subscriptions/<id>/resourceGroups/net/providers/Microsoft.Network/networkManagers/central",
 * });
 * ```
 *
 * @resource
 */
export const NetworkManagerConnection = Resource<NetworkManagerConnection>(
  "Azure.Network.NetworkManagerConnection",
);

type Observed = network.GetSubscriptionNetworkManagerConnectionResponse;

const getConnection = (
  subscriptionId: string,
  networkManagerConnectionName: string,
) =>
  orUndefinedIfNotFound(
    network.GetSubscriptionNetworkManagerConnection({
      subscriptionId,
      networkManagerConnectionName,
    }),
  );

const markerOf = Effect.fn(function* (id: string) {
  const { stack, stage } = yield* stackAndStage;
  return `alchemy:${stack}/${stage}/${id}`;
});

/** The description sent to Azure: the user's text plus the ownership marker. */
const describe = (marker: string, description: string | undefined) =>
  description === undefined ? marker : `${description} [${marker}]`;

/** The user's description with the ownership marker stripped. */
const userDescription = (description: string | undefined) => {
  if (description === undefined || description.startsWith("alchemy:")) {
    return undefined;
  }
  return description.replace(/ \[alchemy:[^\]]*\]$/, "");
};

const toAttrs = (
  name: string,
  observed: Observed,
): NetworkManagerConnection["Attributes"] => ({
  networkManagerConnectionName: name,
  networkManagerConnectionId: observed.id ?? "",
  networkManagerId: observed.properties?.networkManagerId ?? "",
  connectionState: observed.properties?.connectionState,
  description: userDescription(observed.properties?.description),
});

export const NetworkManagerConnectionProvider = () =>
  Provider.succeed(NetworkManagerConnection, {
    stables: [
      "networkManagerConnectionName",
      "networkManagerConnectionId",
      "networkManagerId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* network
        .ListSubscriptionNetworkManagerConnections({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage(
              "ListSubscriptionNetworkManagerConnections",
              page,
            ),
          ),
        );
      return (page.value ?? []).flatMap((connection) =>
        connection.name !== undefined &&
        connection.properties?.description?.includes("alchemy:") === true
          ? [toAttrs(connection.name, connection)]
          : [],
      );
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        (news.name !== undefined &&
          !sameId(news.name, output.networkManagerConnectionName)) ||
        !sameId(news.networkManagerId, output.networkManagerId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const name =
        output?.networkManagerConnectionName ??
        olds?.name ??
        (yield* networkManagerChildName(id));
      const observed = yield* getConnection(subscriptionId, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(name, observed);
      const marker = yield* markerOf(id);
      return observed.properties?.description?.includes(marker)
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const name =
        news.name ??
        output?.networkManagerConnectionName ??
        (yield* networkManagerChildName(id));
      const description = describe(yield* markerOf(id), news.description);

      // Observe -> ensure + sync (one PUT when missing or drifted).
      const observed = yield* getConnection(subscriptionId, name);
      if (
        observed === undefined ||
        !sameId(observed.properties?.networkManagerId, news.networkManagerId) ||
        observed.properties?.description !== description
      ) {
        yield* network
          .SubscriptionNetworkManagerConnectionsCreateOrUpdate({
            subscriptionId,
            networkManagerConnectionName: name,
            properties: {
              networkManagerId: news.networkManagerId,
              description,
            },
          })
          .pipe(Effect.retry(whileNetworkBusy));
      }
      const final = yield* getConnection(subscriptionId, name);
      return toAttrs(name, final ?? {});
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        network.DeleteSubscriptionNetworkManagerConnection({
          subscriptionId,
          networkManagerConnectionName: output.networkManagerConnectionName,
        }),
      );
      yield* waitNetworkGone(
        `network manager connection ${output.networkManagerConnectionName}`,
        getConnection(subscriptionId, output.networkManagerConnectionName),
      );
    }),

    nuke: { dependsOn: ["Azure.Network.ScopeConnection"] },
  });
