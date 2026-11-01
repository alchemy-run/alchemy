/**
 * Shared scaffolding of the STACKIT VPN resources. Not exported from the namespace barrel.
 */
import * as vpn from "@distilled.cloud/stackit/vpn";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { ProjectScope } from "../IaaS/internal.ts";
import { makeKeyedLock } from "../internal/lock.ts";
import { isGeneratedPhysicalName } from "../internal/names.ts";
import { waitFor } from "../internal/wait.ts";
import { isAlchemyOwned } from "../Labels.ts";
import type { GatewayTunnel } from "./Gateway.ts";

/** Budget of the official SDK's create and update handlers. */
export const GATEWAY_READY_TIMEOUT = "45 minutes";
/** Budget of the official SDK's delete handler. */
export const GATEWAY_DELETE_TIMEOUT = "20 minutes";
/** Provisioning takes minutes, so polls start slower than the shared default. */
export const GATEWAY_POLL = { interval: "5 seconds", maxInterval: "30 seconds" } as const;

/** How often a re-submitted gateway may still report its old `ERROR` (about 90s). */
export const STALE_ERROR_POLLS = 6;

const connectionLocks = /*@__PURE__*/ makeKeyedLock();

/**
 * Serialize changes to a gateway's connections: a gateway takes one change at a time, and answers
 * 409 while one is in flight (Terraform's handling of BGP filters; the connection operations
 * declare no 409). Sibling connections deploy concurrently, so this holds a change from the settle
 * that precedes it to the gateway being ready again.
 */
export const withGatewayConnectionLock = (scope: ProjectScope, gatewayId: string) =>
  connectionLocks(`${scope.projectId}/${scope.region}/${gatewayId}`);

/** A display name is 1-63 characters on every VPN object. */
const DISPLAY_NAME_MAX_LENGTH = 63;

/** Physical name for a gateway, connection or BGP filter: letters, digits and hyphens. */
export const generatedName = (id: string) =>
  createPhysicalName({ id, maxLength: DISPLAY_NAME_MAX_LENGTH, lowercase: true });

/** Whether a display name has the shape {@link generatedName} produces. */
export const isGeneratedName = (name: string): boolean =>
  isGeneratedPhysicalName(name, DISPLAY_NAME_MAX_LENGTH);

/** An API response had no `id`. The spec leaves it optional; an object can't exist without one. */
export class MissingId extends Data.TaggedError("Stackit.VPN.MissingId")<{
  readonly resource: string;
  readonly message: string;
}> {}

/** The id of a response object, failing typed when the API left it out. */
export const requireId = (
  resource: string,
  id: string | undefined,
): Effect.Effect<string, MissingId> =>
  id === undefined
    ? Effect.fail(
        new MissingId({ resource, message: `STACKIT returned ${resource} without an id` }),
      )
    : Effect.succeed(id);

/** `GetGateway`; `undefined` when the gateway is gone. */
export const getGatewayOrUndefined = (scope: ProjectScope, gatewayId: string) =>
  vpn.getGateway({ ...scope, gatewayId }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** Every gateway of a project and region. The API has no pagination. */
export const listAllGateways = (scope: ProjectScope) =>
  vpn.listGateways(scope).pipe(Effect.map((response) => response.gateways));

/** The gateways Alchemy created in a project and region, for `list`. */
export const listOwnedGateways = (scope: ProjectScope) =>
  listAllGateways(scope).pipe(
    Effect.map((gateways) => gateways.filter((gateway) => isAlchemyOwned(gateway.labels))),
  );

/**
 * A gateway's connections; none when the gateway is gone, because deleting a gateway
 * removes them with it.
 */
export const listGatewayConnections = (scope: ProjectScope, gatewayId: string) =>
  vpn.listGatewayConnections({ ...scope, gatewayId }).pipe(
    Effect.map((response) => response.connections),
    Effect.catchTag("NotFound", () => Effect.succeed<vpn.ConnectionResponseOutput[]>([])),
  );

/** A gateway's BGP filters; none when the gateway is gone. */
export const listGatewayFilters = (scope: ProjectScope, gatewayId: string) =>
  vpn.listGatewayBGPFilters({ ...scope, gatewayId }).pipe(
    Effect.map((response) => response.bgpFilters),
    Effect.catchTag("NotFound", () => Effect.succeed<vpn.BGPFilter[]>([])),
  );

/** A filter's rules; none when the filter or its gateway is gone. */
export const listFilterRules = (scope: ProjectScope, gatewayId: string, filterId: string) =>
  vpn.listGatewayBGPFilterRules({ ...scope, gatewayId, filterId }).pipe(
    Effect.map((response) => response.rules),
    Effect.catchTag("NotFound", () => Effect.succeed<vpn.BGPFilterRule[]>([])),
  );

/** A gateway's tunnels; none when the gateway is gone. */
export const gatewayTunnels = (scope: ProjectScope, gatewayId: string) =>
  vpn.getGatewayStatus({ ...scope, gatewayId }).pipe(
    Effect.map((status) =>
      (status.tunnels ?? []).map((tunnel): GatewayTunnel => ({
        name: tunnel.name,
        publicIP: tunnel.publicIP,
        internalNextHopIP: tunnel.internalNextHopIP,
      })),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed<GatewayTunnel[]>([])),
  );

const describeGateway = (gatewayId: string) => `STACKIT VPN gateway ${gatewayId}`;

/**
 * Wait until nothing is in flight on a gateway, and return it, or `undefined` when it is
 * gone. An `ERROR` doesn't stop this: the write that follows may be the one that repairs it,
 * and a destroy has to get through a broken gateway.
 */
export const settleGateway = (scope: ProjectScope, gatewayId: string) =>
  waitFor({
    resource: describeGateway(gatewayId),
    read: getGatewayOrUndefined(scope, gatewayId),
    ready: (gateway) => gateway?.state !== "PENDING",
    state: (gateway) => (gateway === undefined ? "gone" : gateway.state),
    timeout: GATEWAY_READY_TIMEOUT,
    ...GATEWAY_POLL,
  });

/**
 * Wait for a gateway to reach `READY`, the official SDK's success state. `ERROR` fails with
 * the message `GetGatewayStatus` carries. `staleErrors` is how many `ERROR` reads to sit out
 * after re-submitting a gateway that was already in `ERROR`.
 */
export const waitForGatewayReady = (
  scope: ProjectScope,
  gatewayId: string,
  options: { readonly staleErrors?: number } = {},
) => {
  let staleErrors = options.staleErrors ?? 0;
  return waitFor({
    resource: describeGateway(gatewayId),
    read: Effect.gen(function* () {
      const gateway = yield* vpn.getGateway({ ...scope, gatewayId });
      if (gateway.state !== "ERROR") return { gateway, errorMessage: undefined };
      const status = yield* vpn.getGatewayStatus({ ...scope, gatewayId });
      return { gateway, errorMessage: status.errorMessage };
    }),
    ready: ({ gateway }) => gateway.state === "READY",
    failed: ({ gateway, errorMessage }) => {
      if (gateway.state === "DELETING") return "it is being deleted";
      if (gateway.state !== "ERROR") {
        staleErrors = 0;
        return undefined;
      }
      if (staleErrors > 0) {
        staleErrors--;
        return undefined;
      }
      return errorMessage ?? "ERROR";
    },
    state: ({ gateway }) => gateway.state,
    timeout: GATEWAY_READY_TIMEOUT,
    ...GATEWAY_POLL,
  }).pipe(Effect.map(({ gateway }) => gateway));
};
