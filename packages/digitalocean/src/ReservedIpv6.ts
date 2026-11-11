import * as DO from "@distilled.cloud/digitalocean";
import type { ReservedIpv6 as ApiReservedIpv6 } from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ignoreNotFound, noneIfNotFound } from "./internal/notFound.ts";
import { pollUntil, type PollBudget } from "./internal/poll.ts";
import type { Providers } from "./Providers.ts";
import type { RegionSlug } from "./Slugs.ts";

export type ReservedIpv6Props = {
  /** Region slug. A change replaces the address. */
  region: RegionSlug;
};

export type ReservedIpv6 = Resource<
  "DigitalOcean.ReservedIpv6",
  ReservedIpv6Props,
  {
    /** The reserved IPv6 address. */
    ip: string;
    /** Region slug. */
    region: string;
    /** Droplet the address is assigned to, if any. */
    dropletId: number | undefined;
    /** ISO 8601 time the address was reserved. */
    reservedAt: string;
  },
  never,
  Providers
>;

export type ReservedIpv6Attributes = ReservedIpv6["Attributes"];

/**
 * A DigitalOcean Reserved IPv6: a static public IPv6 address in one region
 * that you can move between droplets with `ReservedIpv6Assignment`. The
 * droplets need `ipv6: true`.
 *
 * A reserved IPv6 has no name or tags, so Alchemy knows it only by the
 * address it recorded.
 *
 * ### Reserving an IPv6 Address
 * **Example:** A stable IPv6 address for a droplet
 * ```typescript
 * const host = yield* DigitalOcean.Droplet("app", {
 *   region: "nyc3",
 *   size: "s-1vcpu-1gb",
 *   image: "ubuntu-24-04-x64",
 *   ipv6: true,
 * });
 * const ip = yield* DigitalOcean.ReservedIpv6("app-ipv6", { region: "nyc3" });
 * yield* DigitalOcean.ReservedIpv6Assignment("app-ipv6-on-app", {
 *   ip: ip.ip,
 *   dropletId: host.dropletId,
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Reserved-IPv6
 *
 * @resource
 * @product Reserved IPs
 * @category Networking
 */
export const ReservedIpv6 = Resource<ReservedIpv6>("DigitalOcean.ReservedIpv6");

export class ReservedIpv6WaitTimedOut extends Data.TaggedError(
  "DigitalOcean.ReservedIpv6WaitTimedOut",
)<{
  readonly ip: string;
  readonly waitingFor: string;
}> {
  override get message() {
    return `Reserved IPv6 ${this.ip} timed out waiting for ${this.waitingFor}.`;
  }
}

export const RESERVED_IPV6_POLL: PollBudget = { maxDelay: "5 seconds", times: 30 };

export const toReservedIpv6Attrs = (ip: ApiReservedIpv6): ReservedIpv6Attributes => ({
  ip: ip.ip,
  region: ip.region_slug,
  dropletId: ip.droplet?.id,
  reservedAt: ip.reserved_at,
});

export const observeReservedIpv6 = (ip: string) =>
  noneIfNotFound(
    DO.getReservedIPv6({ reserved_ipv6: ip }).pipe(Effect.map((r) => r.reserved_ipv6)),
  );

export const ReservedIpv6Provider = () =>
  Provider.succeed(ReservedIpv6, {
    stables: ["ip", "region", "reservedAt"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const observed = yield* observeReservedIpv6(output.ip);
      return Option.getOrUndefined(Option.map(observed, toReservedIpv6Attrs));
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (news.region !== olds.region) return { action: "replace" } as const;
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const observed = output === undefined ? Option.none() : yield* observeReservedIpv6(output.ip);
      if (Option.isSome(observed)) return toReservedIpv6Attrs(observed.value);
      const created = yield* DO.createReservedIPv6({ region_slug: news.region });
      const ip = created.reserved_ipv6.ip;
      // GET lags the create by a few seconds.
      const ready = yield* pollUntil(observeReservedIpv6(ip), {
        ...RESERVED_IPV6_POLL,
        until: Option.isSome,
        onTimeout: () => new ReservedIpv6WaitTimedOut({ ip, waitingFor: "the address to appear" }),
      });
      return toReservedIpv6Attrs(ready.value);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteReservedIPv6({ reserved_ipv6: output.ip }));
      yield* pollUntil(observeReservedIpv6(output.ip), {
        ...RESERVED_IPV6_POLL,
        until: Option.isNone,
        onTimeout: () => new ReservedIpv6WaitTimedOut({ ip: output.ip, waitingFor: "deletion" }),
      });
    }),
  });
