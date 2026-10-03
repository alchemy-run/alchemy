import * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { waitNetworkProvisionedSlow } from "./common.ts";
import { type NetworkPath, networkProvider } from "./generic.ts";

export interface ExpressRouteCircuitAuthorizationProps {
  /** Resource group of the circuit. Changing it replaces the authorization. */
  resourceGroup: string;
  /** Name of the parent circuit. Changing it replaces the authorization. */
  circuit: string;
  /**
   * Name of the authorization. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the authorization.
   */
  name?: string;
}

export interface ExpressRouteCircuitAuthorization extends Resource<
  "Azure.Network.ExpressRouteCircuitAuthorization",
  ExpressRouteCircuitAuthorizationProps,
  {
    /** Name of the authorization. */
    authorizationName: string;
    /** ARM resource ID of the authorization. */
    authorizationId: string;
    /** Name of the parent circuit. */
    circuit: string;
    /** Resource group of the circuit. */
    resourceGroup: string;
    /**
     * Key another subscription's virtual network gateway connection
     * presents to use the circuit.
     */
    authorizationKey: Redacted.Redacted<string> | undefined;
    /** `Available` or `InUse`. */
    authorizationUseStatus: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An authorization on an Azure ExpressRoute circuit — a key that lets a
 * virtual network gateway in another subscription connect to the circuit.
 * Authorizations carry no tags: ownership follows the parent circuit.
 *
 * @see https://learn.microsoft.com/azure/expressroute/expressroute-howto-linkvnet-arm
 *
 * ### Creating an Authorization
 * **Example:** Share a circuit with another subscription
 * ```typescript
 * const auth = yield* Azure.Network.ExpressRouteCircuitAuthorization("spoke", {
 *   resourceGroup: group.resourceGroupName,
 *   circuit: circuit.circuitName,
 * });
 * // Hand auth.authorizationKey to the connecting subscription.
 * ```
 *
 * @resource
 */
export const ExpressRouteCircuitAuthorization =
  Resource<ExpressRouteCircuitAuthorization>(
    "Azure.Network.ExpressRouteCircuitAuthorization",
  );

const getCircuit = (subscriptionId: string, path: NetworkPath) =>
  orUndefinedIfNotFound(
    network.GetExpressRouteCircuit({
      subscriptionId,
      resourceGroupName: path.resourceGroup,
      circuitName: path.circuit!,
    }),
  );

export const ExpressRouteCircuitAuthorizationProvider = () =>
  Provider.succeed(
    ExpressRouteCircuitAuthorization,
    networkProvider<ExpressRouteCircuitAuthorization>()({
      label: "ExpressRoute circuit authorization",
      nameAttr: "authorizationName",
      parents: ["circuit"],
      tracked: false,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetExpressRouteCircuitAuthorization({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            circuitName: path.circuit!,
            authorizationName: path.name,
          }),
        ),
      // The circuit rejects child writes until it finished provisioning.
      put: (subscriptionId, path, body) =>
        waitNetworkProvisionedSlow(
          `ExpressRoute circuit ${path.circuit}`,
          getCircuit(subscriptionId, path),
        ).pipe(
          Effect.andThen(
            network.ExpressRouteCircuitAuthorizationsCreateOrUpdate({
              subscriptionId,
              resourceGroupName: path.resourceGroup,
              circuitName: path.circuit!,
              authorizationName: path.name,
              ...body,
            }),
          ),
        ),
      del: (subscriptionId, path) =>
        network.DeleteExpressRouteCircuitAuthorization({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          circuitName: path.circuit!,
          authorizationName: path.name,
        }),
      ownerTags: (subscriptionId, path) =>
        getCircuit(subscriptionId, path).pipe(
          Effect.map((circuit) => circuit?.tags),
        ),
      body: () => ({ properties: {} }),
      drifted: () => false,
      toAttrs: (path, observed) => ({
        authorizationName: path.name,
        authorizationId: observed.id ?? "",
        circuit: path.circuit!,
        resourceGroup: path.resourceGroup,
        authorizationKey:
          observed.properties?.authorizationKey === undefined
            ? undefined
            : Redacted.make(observed.properties.authorizationKey),
        authorizationUseStatus: observed.properties?.authorizationUseStatus,
      }),
      dependsOn: ["Azure.Network.ExpressRouteCircuit"],
    }),
  );
