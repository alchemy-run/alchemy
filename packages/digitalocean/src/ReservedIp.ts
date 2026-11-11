import * as DO from "@distilled.cloud/digitalocean";
import type { ReservedIp as ApiReservedIp } from "@distilled.cloud/digitalocean";
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

export type ReservedIpProps = {
  /** Region slug. The IP can be assigned only to droplets in this region. A change replaces the IP. */
  region: RegionSlug;
};

export type ReservedIp = Resource<
  "DigitalOcean.ReservedIp",
  ReservedIpProps,
  {
    /** The reserved IPv4 address. */
    ip: string;
    /** Region slug. */
    region: string;
    /** Id of the droplet the IP is assigned to, if any. */
    dropletId: number | undefined;
    /** Project the IP belongs to. */
    projectId: string | undefined;
  },
  never,
  Providers
>;

export type ReservedIpAttributes = ReservedIp["Attributes"];

/**
 * A DigitalOcean Reserved IP: a static public IPv4 address in one region
 * that you can move between droplets. Point DNS at the reserved IP, and a
 * droplet replacement keeps the address. Assign it with
 * `ReservedIpAssignment`.
 *
 * A reserved IP has no name or tags, so Alchemy knows it only by the
 * address it recorded. An IP created by a deploy that crashed before saving
 * state is not found again; delete it in the control panel. DigitalOcean
 * bills a reserved IP that is not assigned to a droplet.
 *
 * ### Creating a Reserved IP
 * **Example:** A stable address for a droplet
 * ```typescript
 * const host = yield* DigitalOcean.Droplet("app", {
 *   region: "sfo3",
 *   size: "s-1vcpu-1gb",
 *   image: "ubuntu-24-04-x64",
 * });
 * const ip = yield* DigitalOcean.ReservedIp("app-ip", { region: "sfo3" });
 * yield* DigitalOcean.ReservedIpAssignment("app-ip-on-app", {
 *   ip: ip.ip,
 *   dropletId: host.dropletId,
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Reserved-IPs
 *
 * @resource
 * @product Reserved IPs
 * @category Networking
 */
export const ReservedIp = Resource<ReservedIp>("DigitalOcean.ReservedIp");

export class ReservedIpWaitTimedOut extends Data.TaggedError(
  "DigitalOcean.ReservedIpWaitTimedOut",
)<{
  readonly ip: string;
  readonly waitingFor: string;
}> {
  override get message() {
    return `Reserved IP ${this.ip} timed out waiting for ${this.waitingFor}.`;
  }
}

// GET lags a change by a few seconds.
const RESERVED_IP_POLL: PollBudget = { maxDelay: "3 seconds", times: 20 };

export const toReservedIpAttrs = (reservedIp: ApiReservedIp): ReservedIpAttributes => ({
  ip: reservedIp.ip,
  region: reservedIp.region.slug,
  dropletId: reservedIp.droplet?.id,
  projectId: reservedIp.project_id || undefined,
});

export const observeReservedIp = (ip: string) =>
  noneIfNotFound(DO.getReservedIP({ reserved_ip: ip }).pipe(Effect.map((r) => r.reserved_ip)));

const waitUntilGone = (ip: string) =>
  pollUntil(observeReservedIp(ip), {
    ...RESERVED_IP_POLL,
    until: Option.isNone,
    onTimeout: () => new ReservedIpWaitTimedOut({ ip, waitingFor: "deletion" }),
  });

export const ReservedIpProvider = () =>
  Provider.succeed(ReservedIp, {
    stables: ["ip", "region"],
    // A reserved IP carries no ownership marker.
    nuke: { skip: true },
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const observed = yield* observeReservedIp(output.ip);
      return Option.getOrUndefined(Option.map(observed, toReservedIpAttrs));
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (news.region !== olds.region) return { action: "replace" } as const;
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const observed = output === undefined ? Option.none() : yield* observeReservedIp(output.ip);
      const reservedIp = yield* Option.match(observed, {
        onNone: () =>
          DO.createReservedIP({ body: { region: news.region } }).pipe(
            Effect.map((response) => response.reserved_ip),
          ),
        onSome: Effect.succeed,
      });
      return toReservedIpAttrs(reservedIp);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteReservedIP({ reserved_ip: output.ip }));
      yield* waitUntilGone(output.ip);
    }),
  });
