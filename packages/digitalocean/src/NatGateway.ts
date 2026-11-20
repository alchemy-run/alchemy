import * as DO from "@distilled.cloud/digitalocean";
import type {
  CreateVpcnatgatewayRequestRegion,
  VpcNatGatewayGet,
} from "@distilled.cloud/digitalocean";

/** Regions that offer VPC NAT gateways. */
export type NatGatewayRegion = CreateVpcnatgatewayRequestRegion;
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { setEquals } from "./internal/equal.ts";
import { ignoreNotFound, noneIfNotFound } from "./internal/notFound.ts";
import { pollUntil, type PollBudget } from "./internal/poll.ts";
import type { Providers } from "./Providers.ts";

export type NatGatewayProps = {
  /**
   * Gateway name. A change renames it in place.
   *
   * @default a generated physical name
   */
  name?: string;
  /** Region slug. A change replaces the gateway. */
  region: NatGatewayRegion;
  /** VPCs whose droplets send outbound traffic through the gateway. Updates in place. */
  vpcIds: string[];
  /** Gateway size units; each adds throughput. Updates in place. @default 1 */
  size?: number;
  /** Idle timeout of UDP flows, in seconds. */
  udpTimeoutSeconds?: number;
  /** Idle timeout of ICMP flows, in seconds. */
  icmpTimeoutSeconds?: number;
  /** Idle timeout of TCP flows, in seconds. */
  tcpTimeoutSeconds?: number;
};

export type NatGateway = Resource<
  "DigitalOcean.NatGateway",
  NatGatewayProps,
  {
    /** Gateway id (UUID). */
    natGatewayId: string;
    /** Gateway name. */
    name: string;
    /** `ACTIVE` once traffic flows. */
    state: string;
    /** Region slug. */
    region: string;
    /** Public IPv4 addresses outbound traffic leaves from. */
    egressIps: string[];
  },
  never,
  Providers
>;

export type NatGatewayAttributes = NatGateway["Attributes"];

/**
 * A DigitalOcean VPC NAT gateway: droplets in the VPCs reach the internet
 * through it, from a fixed public address, without public IPs of their
 * own. VPCs, size, timeouts and the name update in place; `region`
 * replaces the gateway.
 *
 * ### Routing Outbound Traffic
 * **Example:** A fixed egress address for private droplets
 * ```typescript
 * const network = yield* DigitalOcean.Vpc("network", { region: "nyc3" });
 * const nat = yield* DigitalOcean.NatGateway("egress", {
 *   region: "nyc3",
 *   vpcIds: [network.vpcId],
 * });
 * // Allow nat.egressIps in third-party firewalls.
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/VPC-NAT-Gateways
 *
 * @resource
 * @product VPC
 * @category Networking
 */
export const NatGateway = Resource<NatGateway>("DigitalOcean.NatGateway");

export class NatGatewayWaitTimedOut extends Data.TaggedError(
  "DigitalOcean.NatGatewayWaitTimedOut",
)<{
  readonly natGatewayId: string;
  readonly waitingFor: string;
  readonly lastState: string | undefined;
}> {
  override get message() {
    return `NAT gateway ${this.natGatewayId} timed out waiting for ${this.waitingFor} (last state: ${this.lastState ?? "missing"}).`;
  }
}

// A gateway provisions in a few minutes (≈ 10 min budget).
const NAT_POLL: PollBudget = { maxDelay: "10 seconds", times: 64 };

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 63 });

const toAttrs = (nat: VpcNatGatewayGet): NatGatewayAttributes => ({
  natGatewayId: nat.id,
  name: nat.name,
  state: nat.state,
  region: nat.region,
  egressIps: (nat.egresses?.public_gateways ?? []).flatMap((gw) =>
    gw.ipv4 === undefined ? [] : [gw.ipv4],
  ),
});

const observeById = (natGatewayId: string) =>
  noneIfNotFound(
    DO.getVpcnatgateway({ id: natGatewayId }).pipe(Effect.map((r) => r.vpc_nat_gateway)),
  );

const observeByName = (name: string) =>
  DO.listVpcnatgateways.items({ per_page: 200 }).pipe(
    Stream.filter((nat) => nat.name === name),
    Stream.runHead,
  );

const waitFor = (
  natGatewayId: string,
  waitingFor: string,
  until: (o: Option.Option<VpcNatGatewayGet>) => boolean,
) =>
  pollUntil(observeById(natGatewayId), {
    ...NAT_POLL,
    until,
    onTimeout: (last) =>
      new NatGatewayWaitTimedOut({
        natGatewayId,
        waitingFor,
        lastState: Option.getOrUndefined(last)?.state,
      }),
  });

export const NatGatewayProvider = () =>
  Provider.succeed(NatGateway, {
    stables: ["natGatewayId", "region"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ id, olds, output }) {
      if (output !== undefined) {
        const byId = yield* observeById(output.natGatewayId);
        if (Option.isSome(byId)) return toAttrs(byId.value);
      }
      if (olds.name !== undefined) return undefined;
      const generatedName = yield* physicalName(id);
      const named = yield* observeByName(generatedName);
      return Option.getOrUndefined(Option.map(named, toAttrs));
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (news.region !== olds.region) return { action: "replace" } as const;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = news.name ?? (yield* physicalName(id));
      const vpcs = news.vpcIds.map((vpc_uuid) => ({ vpc_uuid }));
      const timeouts = {
        udp_timeout_seconds: news.udpTimeoutSeconds,
        icmp_timeout_seconds: news.icmpTimeoutSeconds,
        tcp_timeout_seconds: news.tcpTimeoutSeconds,
      };
      const byId = output === undefined ? Option.none() : yield* observeById(output.natGatewayId);
      const observed = Option.isSome(byId)
        ? byId
        : news.name === undefined
          ? yield* observeByName(name)
          : Option.none<VpcNatGatewayGet>();
      const nat = yield* Option.match(observed, {
        onNone: () =>
          DO.createVpcnatgateway({
            name,
            type: "PUBLIC",
            region: news.region,
            size: news.size ?? 1,
            vpcs,
            ...timeouts,
          }).pipe(
            // The create response carries no id; the name finds the gateway.
            Effect.andThen(
              pollUntil(observeByName(name), {
                ...NAT_POLL,
                until: Option.isSome,
                onTimeout: () =>
                  new NatGatewayWaitTimedOut({
                    natGatewayId: name,
                    waitingFor: "the new gateway to appear",
                    lastState: undefined,
                  }),
              }),
            ),
            Effect.map((found) => Option.getOrUndefined(found)?.id ?? ""),
          ),
        onSome: (existing) =>
          (existing.name === name &&
          existing.size === (news.size ?? 1) &&
          setEquals(
            existing.vpcs.map((v) => v.vpc_uuid),
            news.vpcIds,
          )
            ? Effect.void
            : DO.updateVpcnatgateway({
                id: existing.id,
                name,
                size: news.size ?? 1,
                vpcs,
                ...timeouts,
              }).pipe(Effect.asVoid)
          ).pipe(Effect.as(existing.id)),
      });
      const active = yield* pollUntil(observeById(nat), {
        ...NAT_POLL,
        until: (o): o is Option.Some<VpcNatGatewayGet> =>
          Option.isSome(o) && o.value.state === "ACTIVE" && o.value.name === name,
        onTimeout: (last) =>
          new NatGatewayWaitTimedOut({
            natGatewayId: nat,
            waitingFor: "the active state",
            lastState: Option.getOrUndefined(last)?.state,
          }),
      });
      return toAttrs(active.value);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteVpcnatgateway({ id: output.natGatewayId }));
      yield* waitFor(output.natGatewayId, "deletion", Option.isNone);
    }),
  });
