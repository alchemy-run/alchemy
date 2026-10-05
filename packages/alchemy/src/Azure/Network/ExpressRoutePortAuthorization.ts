import * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { waitNetworkProvisionedSlow } from "./common.ts";
import { type NetworkPath, networkProvider } from "./generic.ts";

export interface ExpressRoutePortAuthorizationProps {
  /** Resource group of the port. Changing it replaces the authorization. */
  resourceGroup: string;
  /** Name of the parent ExpressRoute port. Changing it replaces the authorization. */
  expressRoutePort: string;
  /**
   * Name of the authorization. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the authorization.
   */
  name?: string;
}

export interface ExpressRoutePortAuthorization extends Resource<
  "Azure.Network.ExpressRoutePortAuthorization",
  ExpressRoutePortAuthorizationProps,
  {
    /** Name of the authorization. */
    authorizationName: string;
    /** ARM resource ID of the authorization. */
    authorizationId: string;
    /** Name of the parent ExpressRoute port. */
    expressRoutePort: string;
    /** Resource group of the port. */
    resourceGroup: string;
    /**
     * Key a circuit in another subscription presents to be created on the
     * port.
     */
    authorizationKey: Redacted.Redacted<string> | undefined;
    /** `Available` or `InUse`. */
    authorizationUseStatus: string | undefined;
    /** ID of the circuit using the authorization. */
    circuitResourceUri: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An authorization on an Azure ExpressRoute Direct port — a key that lets
 * another subscription create an ExpressRoute circuit on the port.
 * Authorizations carry no tags: ownership follows the parent port.
 *
 * @see https://learn.microsoft.com/azure/expressroute/expressroute-howto-erdirect
 *
 * ### Creating an Authorization
 * **Example:** Share a port with another subscription
 * ```typescript
 * const auth = yield* Azure.Network.ExpressRoutePortAuthorization("spoke", {
 *   resourceGroup: group.resourceGroupName,
 *   expressRoutePort: port.expressRoutePortName,
 * });
 * // Hand auth.authorizationKey to the connecting subscription.
 * ```
 *
 * @resource
 */
export const ExpressRoutePortAuthorization =
  Resource<ExpressRoutePortAuthorization>(
    "Azure.Network.ExpressRoutePortAuthorization",
  );

const getPort = (subscriptionId: string, path: NetworkPath) =>
  orUndefinedIfNotFound(
    network.GetExpressRoutePort({
      subscriptionId,
      resourceGroupName: path.resourceGroup,
      expressRoutePortName: path.expressRoutePort!,
    }),
  );

export const ExpressRoutePortAuthorizationProvider = () =>
  Provider.succeed(
    ExpressRoutePortAuthorization,
    networkProvider<ExpressRoutePortAuthorization>()({
      label: "ExpressRoute port authorization",
      nameAttr: "authorizationName",
      parents: ["expressRoutePort"],
      tracked: false,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetExpressRoutePortAuthorization({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            expressRoutePortName: path.expressRoutePort!,
            authorizationName: path.name,
          }),
        ),
      // The port rejects child writes until it finished provisioning.
      put: (subscriptionId, path, body) =>
        waitNetworkProvisionedSlow(
          `ExpressRoute port ${path.expressRoutePort}`,
          getPort(subscriptionId, path),
        ).pipe(
          Effect.andThen(
            network.ExpressRoutePortAuthorizationsCreateOrUpdate({
              subscriptionId,
              resourceGroupName: path.resourceGroup,
              expressRoutePortName: path.expressRoutePort!,
              authorizationName: path.name,
              ...body,
            }),
          ),
        ),
      del: (subscriptionId, path) =>
        network.DeleteExpressRoutePortAuthorization({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          expressRoutePortName: path.expressRoutePort!,
          authorizationName: path.name,
        }),
      ownerTags: (subscriptionId, path) =>
        getPort(subscriptionId, path).pipe(Effect.map((port) => port?.tags)),
      body: () => ({ properties: {} }),
      drifted: () => false,
      toAttrs: (path, observed) => ({
        authorizationName: path.name,
        authorizationId: observed.id ?? "",
        expressRoutePort: path.expressRoutePort!,
        resourceGroup: path.resourceGroup,
        authorizationKey:
          observed.properties?.authorizationKey === undefined
            ? undefined
            : Redacted.make(observed.properties.authorizationKey),
        authorizationUseStatus: observed.properties?.authorizationUseStatus,
        circuitResourceUri: observed.properties?.circuitResourceUri,
      }),
      dependsOn: ["Azure.Network.ExpressRoutePort"],
    }),
  );
