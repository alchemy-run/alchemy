import type * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import { stackAndStage, waitForProvisioned, waitUntilGone } from "../Arm.ts";

// Shared Microsoft.Network helpers. Internal: not exported from index.ts.

/** Unwrap a secret prop that may be given as plain text or `Redacted`. */
export const reveal = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? Redacted.value(value)
      : value;

/**
 * Whether a write-only secret changed since the previous deploy (always
 * true on adoption, when there is no previous deploy).
 */
export const secretChanged = (
  next: string | Redacted.Redacted<string> | undefined,
  prev: string | Redacted.Redacted<string> | undefined,
  hasOlds: boolean,
) => next !== undefined && (!hasOlds || reveal(next) !== reveal(prev));

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
 * firewall, hub, gateway) to reach `Succeeded`: these take 5-60 minutes.
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
    { interval: "15 seconds", times: 240 },
  );

/** Wait for a slow Microsoft.Network resource to disappear (up to ~60 min). */
export const waitNetworkGoneSlow = <A, E, R>(
  label: string,
  get: Effect.Effect<A | undefined, E, R>,
) => waitUntilGone(label, get, { interval: "15 seconds", times: 240 });

/** Last segment of an ARM ID (the sub-resource name). */
export const nameOf = (armId: string | undefined) => armId?.split("/").pop();

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
 * Converge a child resource (route, security rule, peering) whose parent
 * PUT re-sends the observed child collection. A parent update racing the
 * child write can carry a stale copy of the child and revert it, so after
 * applying, wait for the parent to settle, re-observe the child, and
 * re-apply while it drifted (bounded).
 */
export const convergeChild = <
  A extends { readonly properties?: { readonly provisioningState?: string } },
  P extends { readonly properties?: { readonly provisioningState?: string } },
  E1,
  R1,
  E2,
  R2,
  E3,
  R3,
>(options: {
  readonly label: string;
  readonly get: Effect.Effect<A | undefined, E1, R1>;
  readonly getParent: Effect.Effect<P | undefined, E2, R2>;
  readonly drifted: (observed: A | undefined) => boolean;
  readonly apply: Effect.Effect<unknown, E3, R3>;
}) =>
  Effect.gen(function* () {
    const { label, get, getParent, drifted, apply } = options;
    let observed: A | undefined;
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (drifted(yield* get)) yield* apply;
      observed = yield* waitNetworkProvisioned(label, get);
      yield* waitNetworkProvisioned(`parent of ${label}`, getParent);
      const settled = yield* get;
      if (settled !== undefined && !drifted(settled)) return settled;
    }
    return observed!;
  });

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
