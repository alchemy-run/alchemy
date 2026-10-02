import type * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import { stackAndStage, waitForProvisioned, waitUntilGone } from "../Arm.ts";

// Shared Microsoft.Network helpers. Internal: not exported from index.ts.

export const lower = (value: string | undefined) => value?.toLowerCase();

/** Case-insensitive equality of ARM names, IDs, and locations. */
export const sameId = (a: string | undefined, b: string | undefined) =>
  lower(a) === lower(b);

/** `{ id }` sub-resource reference, or `undefined`. */
export const ref = (id: string | undefined) =>
  id === undefined ? undefined : { id };

/** Order-insensitive, case-insensitive list equality (`undefined` = `[]`). */
export const sameSet = (
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
) => {
  const left = (a ?? []).map((v) => v.toLowerCase()).sort();
  const right = (b ?? []).map((v) => v.toLowerCase()).sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
};

/** Canonical JSON (sorted keys, `undefined` dropped) for structural diffs. */
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, (v as Record<string, unknown>)[k]]),
        )
      : v,
  );

/**
 * Physical name for a Microsoft.Network resource: 1-80 characters of
 * letters, digits, `_`, `.`, `-`, starting with a letter or digit.
 */
export const createNetworkName = (id: string, maxLength = 80) =>
  createPhysicalName({ id, maxLength });

/**
 * The Network RP serialises writes per VNet / NSG / load balancer and
 * rejects concurrent ones with `AnotherOperationInProgress`.
 */
export const whileNetworkBusy = {
  while: (e: { readonly _tag: string }) =>
    e._tag === "NetworkOperationInProgress",
  schedule: Schedule.spaced("5 seconds"),
  times: 24,
} as const;

/**
 * Retry a delete while a dependency still references the resource (the
 * engine deletes dependents first, but Azure releases references a few
 * seconds after their delete completes).
 */
export const whileInUse = (tags: ReadonlyArray<string>) =>
  ({
    while: (e: { readonly _tag: string }) =>
      tags.includes(e._tag) || e._tag === "NetworkOperationInProgress",
    schedule: Schedule.spaced("5 seconds"),
    times: 36,
  }) as const;

/** Wait for a Microsoft.Network resource to reach `Succeeded`. */
export const waitNetworkProvisioned = <
  A extends { readonly properties?: { readonly provisioningState?: string } },
  E,
  R,
>(
  label: string,
  get: Effect.Effect<A | undefined, E, R>,
) =>
  waitForProvisioned(
    label,
    get,
    (value) => value.properties?.provisioningState,
    {
      interval: "3 seconds",
      times: 100,
    },
  );

/**
 * Wait for a slow Microsoft.Network resource (application gateway,
 * firewall) to reach `Succeeded`: these take 5-20 minutes.
 */
export const waitNetworkProvisionedSlow = <
  A extends { readonly properties?: { readonly provisioningState?: string } },
  E,
  R,
>(
  label: string,
  get: Effect.Effect<A | undefined, E, R>,
) =>
  waitForProvisioned(
    label,
    get,
    (value) => value.properties?.provisioningState,
    { interval: "15 seconds", times: 100 },
  );

/** Wait for a slow Microsoft.Network resource to disappear (up to ~25 min). */
export const waitNetworkGoneSlow = <A, E, R>(
  label: string,
  get: Effect.Effect<A | undefined, E, R>,
) => waitUntilGone(label, get, { interval: "15 seconds", times: 100 });

/** Last segment of an ARM ID (the sub-resource name). */
export const nameOf = (armId: string | undefined) =>
  armId?.split("/").pop();

/** Wait for a deleted Microsoft.Network resource to disappear. */
export const waitNetworkGone = <A, E, R>(
  label: string,
  get: Effect.Effect<A | undefined, E, R>,
) => waitUntilGone(label, get, { interval: "3 seconds", times: 100 });

/**
 * Re-encode an observed subnet as PUT input. Parent PUTs (VirtualNetwork)
 * replace the whole subnet collection, so they must carry every observed
 * subnet with its associations intact.
 */
export const subnetInput = (
  subnet: network.Subnet_6,
): network.SubnetInput_4 => {
  const p = subnet.properties;
  return {
    id: subnet.id,
    name: subnet.name,
    properties: p && {
      addressPrefix: p.addressPrefix,
      addressPrefixes: p.addressPrefixes,
      networkSecurityGroup: ref(p.networkSecurityGroup?.id),
      routeTable: ref(p.routeTable?.id),
      natGateway: ref(p.natGateway?.id),
      serviceGateway: ref(p.serviceGateway?.id),
      serviceEndpoints: p.serviceEndpoints?.map((endpoint) => ({
        service: endpoint.service,
        locations: endpoint.locations,
      })),
      serviceEndpointPolicies: p.serviceEndpointPolicies?.flatMap((policy) =>
        policy.id === undefined ? [] : [{ id: policy.id }],
      ),
      delegations: p.delegations?.map((delegation) => ({
        name: delegation.name,
        properties: { serviceName: delegation.properties?.serviceName },
      })),
      privateEndpointNetworkPolicies: p.privateEndpointNetworkPolicies,
      privateLinkServiceNetworkPolicies: p.privateLinkServiceNetworkPolicies,
      defaultOutboundAccess: p.defaultOutboundAccess,
      sharingScope: p.sharingScope,
    },
  };
};

/**
 * Ownership of tagless child resources (subnets, routes, peerings, DNS zone
 * groups): the parent carries this stack's and stage's ownership tags.
 */
export const parentOwned = Effect.fn(function* (
  tags: Record<string, string | undefined> | undefined,
) {
  const { stack, stage } = yield* stackAndStage;
  return tags?.["alchemy::stack"] === stack && tags["alchemy::stage"] === stage;
});

/** Re-encode an observed VNet peering as PUT input (see {@link subnetInput}). */
export const peeringInput = (
  peering: network.VirtualNetworkPeering,
): network.VirtualNetworkPeeringInput => {
  const p = peering.properties;
  return {
    id: peering.id,
    name: peering.name,
    properties: p && {
      allowVirtualNetworkAccess: p.allowVirtualNetworkAccess,
      allowForwardedTraffic: p.allowForwardedTraffic,
      allowGatewayTransit: p.allowGatewayTransit,
      useRemoteGateways: p.useRemoteGateways,
      remoteVirtualNetwork: ref(p.remoteVirtualNetwork?.id),
      doNotVerifyRemoteGateways: p.doNotVerifyRemoteGateways,
      peerCompleteVnets: p.peerCompleteVnets,
      enableOnlyIPv6Peering: p.enableOnlyIPv6Peering,
      localSubnetNames: p.localSubnetNames,
      remoteSubnetNames: p.remoteSubnetNames,
    },
  };
};
