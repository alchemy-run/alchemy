import * as vmware from "@distilled.cloud/azure/vmware";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
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
  AVS_NAMESPACE,
  CHILD_BUDGET,
  createAvsName,
  isPrivateCloudOwnedByStack,
  parentChanged,
  sameName,
  unredact,
} from "./common.ts";

export interface GlobalReachConnectionProps {
  /** Resource group of the private cloud. Changing it replaces the connection. */
  resourceGroup: string;
  /** Name of the private cloud. Changing it replaces the connection. */
  privateCloud: string;
  /**
   * Name of the Global Reach connection. If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the connection.
   */
  name?: string;
  /**
   * Authorization key from the peer ExpressRoute circuit. Changing it
   * replaces the connection.
   */
  authorizationKey?: Redacted.Redacted<string>;
  /**
   * ID of the ExpressRoute circuit to peer with. Changing it replaces the
   * connection.
   */
  peerExpressRouteCircuit?: string;
  /**
   * ID of the private cloud's ExpressRoute circuit (for a peer within the
   * same subscription). Changing it replaces the connection.
   */
  expressRouteId?: string;
}

export interface GlobalReachConnection extends Resource<
  "Azure.VMware.GlobalReachConnection",
  GlobalReachConnectionProps,
  {
    /** Name of the Global Reach connection. */
    globalReachConnectionName: string;
    /** ARM resource ID of the connection. */
    globalReachConnectionResourceId: string;
    /** Resource group of the private cloud. */
    resourceGroup: string;
    /** Name of the private cloud. */
    privateCloud: string;
    /** Network carved out of the private cloud's block for Global Reach. */
    addressPrefix: string | undefined;
    /** Connection status (`Connected`, `Connecting`, `Disconnected`). */
    circuitConnectionStatus: string | undefined;
    /** ID of the peered ExpressRoute circuit. */
    peerExpressRouteCircuit: string | undefined;
    /** Provisioning state. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An ExpressRoute Global Reach connection between an Azure VMware Solution
 * private cloud's circuit and another (e.g. on-premises) ExpressRoute circuit.
 *
 * @see https://learn.microsoft.com/azure/azure-vmware/tutorial-expressroute-global-reach-private-cloud
 *
 * ### Connecting On-Premises
 * **Example:** Peer with an on-premises circuit
 * ```typescript
 * yield* Azure.VMware.GlobalReachConnection("onprem", {
 *   resourceGroup: group.resourceGroupName,
 *   privateCloud: cloud.privateCloudName,
 *   peerExpressRouteCircuit: onPremCircuitId,
 *   authorizationKey: Redacted.make(onPremAuthorizationKey),
 * });
 * ```
 *
 * @resource
 */
export const GlobalReachConnection = Resource<GlobalReachConnection>(
  "Azure.VMware.GlobalReachConnection",
);

const createName = (id: string) => createAvsName(id, 64);

const getGlobalReachConnection = (
  subscriptionId: string,
  resourceGroupName: string,
  privateCloudName: string,
  globalReachConnectionName: string,
) =>
  orUndefinedIfNotFound(
    vmware.GetGlobalReachConnection({
      subscriptionId,
      resourceGroupName,
      privateCloudName,
      globalReachConnectionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  privateCloud: string,
  name: string,
  observed: vmware.GetGlobalReachConnectionResponse,
): GlobalReachConnection["Attributes"] => ({
  globalReachConnectionName: name,
  globalReachConnectionResourceId: observed.id ?? "",
  resourceGroup,
  privateCloud,
  addressPrefix: observed.properties?.addressPrefix,
  circuitConnectionStatus: observed.properties?.circuitConnectionStatus,
  peerExpressRouteCircuit: observed.properties?.peerExpressRouteCircuit,
  provisioningState: observed.properties?.provisioningState,
});

export const GlobalReachConnectionProvider = () =>
  Provider.succeed(GlobalReachConnection, {
    stables: [
      "globalReachConnectionName",
      "globalReachConnectionResourceId",
      "resourceGroup",
      "privateCloud",
    ],

    // Lives inside a private cloud; nuke removes it with the private cloud.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        parentChanged(news, output) ||
        (news.name !== undefined &&
          news.name !== output.globalReachConnectionName) ||
        (olds !== undefined &&
          (!sameName(
            news.peerExpressRouteCircuit,
            olds.peerExpressRouteCircuit,
          ) ||
            !sameName(news.expressRouteId, olds.expressRouteId) ||
            unredact(news.authorizationKey) !==
              unredact(olds.authorizationKey)))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const privateCloud = output?.privateCloud ?? olds?.privateCloud;
      if (resourceGroup === undefined || privateCloud === undefined) {
        return undefined;
      }
      const name =
        output?.globalReachConnectionName ??
        olds?.name ??
        (yield* createName(id));
      const observed = yield* getGlobalReachConnection(
        subscriptionId,
        resourceGroup,
        privateCloud,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, privateCloud, name, observed);
      return (yield* isPrivateCloudOwnedByStack(
        subscriptionId,
        resourceGroup,
        privateCloud,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, AVS_NAMESPACE);
      const { resourceGroup, privateCloud } = news;
      const name =
        news.name ??
        output?.globalReachConnectionName ??
        (yield* createName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        privateCloudName: privateCloud,
        globalReachConnectionName: name,
      };
      const get = getGlobalReachConnection(
        subscriptionId,
        resourceGroup,
        privateCloud,
        name,
      );
      const wait = () =>
        waitForProvisioned(
          `AVS Global Reach connection ${name}`,
          get,
          (value) => value.properties?.provisioningState,
          CHILD_BUDGET,
        );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* vmware.GlobalReachConnectionsCreateOrUpdate({
          ...where,
          properties: {
            authorizationKey: unredact(news.authorizationKey),
            peerExpressRouteCircuit: news.peerExpressRouteCircuit,
            expressRouteId: news.expressRouteId,
          },
        });
      }
      observed = yield* wait();

      return toAttrs(resourceGroup, privateCloud, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        vmware.DeleteGlobalReachConnection({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          privateCloudName: output.privateCloud,
          globalReachConnectionName: output.globalReachConnectionName,
        }),
      );
      yield* waitUntilGone(
        `AVS Global Reach connection ${output.globalReachConnectionName}`,
        getGlobalReachConnection(
          subscriptionId,
          output.resourceGroup,
          output.privateCloud,
          output.globalReachConnectionName,
        ),
        CHILD_BUDGET,
      );
    }),
  });
