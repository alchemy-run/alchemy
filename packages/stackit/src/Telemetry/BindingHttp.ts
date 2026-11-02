import type { BindingScope } from "../LoadBalancer/BindingScope.ts";
import * as StackitBindings from "../StackitBindings.ts";
import type { AccessToken } from "./AccessToken.ts";
import type { Destination } from "./Destination.ts";
import type { Router } from "./Router.ts";

/**
 * Shared HTTP scaffolding for Telemetry Router bindings.
 * NOT exported from index.ts.
 *
 * Grants list exactly what the operation needs, the `x-stackit-authorization` action in the
 * API spec, on the project holding the resource: STACKIT binds roles on nothing narrower.
 */

interface HttpBindingOptions<I, A, E> {
  /** Fully-qualified binding tag, e.g. `Stackit.Telemetry.GetRouter`. */
  tag: string;
  /** The `x-stackit-authorization` action of the operation. */
  permission: string;
  /** The distilled operation; the bound resource's identifiers are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}

/** A binding on a whole project and region: `<Op>Http.ts` is one call to it. */
export const makeRouterScopeHttpBinding = <I extends { projectId: string; regionId: string }, A, E>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (scope: BindingScope) => ({
      projectId: scope.projectId,
      regionId: scope.region,
    }),
    grants: (scope) => [StackitBindings.grantOn(scope, { permissions: [options.permission] })],
  });

/** A binding on a router: `<Op>Http.ts` is one call to it. */
export const makeRouterHttpBinding = <
  I extends { projectId: string; regionId: string; telemetryRouterId: string },
  A,
  E,
>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (router: Router) => ({
      projectId: router.projectId,
      regionId: router.region,
      telemetryRouterId: router.routerId,
    }),
    grants: (router) => [StackitBindings.grantOn(router, { permissions: [options.permission] })],
  });

/** A binding on a destination: `<Op>Http.ts` is one call to it. */
export const makeDestinationHttpBinding = <
  I extends {
    projectId: string;
    regionId: string;
    telemetryRouterId: string;
    destinationId: string;
  },
  A,
  E,
>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (destination: Destination) => ({
      projectId: destination.projectId,
      regionId: destination.region,
      telemetryRouterId: destination.routerId,
      destinationId: destination.destinationId,
    }),
    grants: (destination) => [
      StackitBindings.grantOn(destination, { permissions: [options.permission] }),
    ],
  });

/** A binding on an access token: `<Op>Http.ts` is one call to it. */
export const makeAccessTokenHttpBinding = <
  I extends {
    projectId: string;
    regionId: string;
    telemetryRouterId: string;
    accessTokenId: string;
  },
  A,
  E,
>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (token: AccessToken) => ({
      projectId: token.projectId,
      regionId: token.region,
      telemetryRouterId: token.routerId,
      accessTokenId: token.accessTokenId,
    }),
    grants: (token) => [StackitBindings.grantOn(token, { permissions: [options.permission] })],
  });
