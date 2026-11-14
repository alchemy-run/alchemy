import * as DO from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { pollUntil } from "./internal/poll.ts";
import type { Providers } from "./Providers.ts";
import {
  observeReservedIpv6,
  RESERVED_IPV6_POLL,
  ReservedIpv6WaitTimedOut,
} from "./ReservedIpv6.ts";

export type ReservedIpv6AssignmentProps = {
  /** The reserved IPv6 address. */
  ip: string;
  /** Droplet in the address's region, with `ipv6: true`. A change moves the address. */
  dropletId: number;
};

export type ReservedIpv6Assignment = Resource<
  "DigitalOcean.ReservedIpv6Assignment",
  ReservedIpv6AssignmentProps,
  {
    /** The reserved IPv6 address. */
    ip: string;
    /** Droplet the address is assigned to. */
    dropletId: number;
  },
  never,
  Providers
>;

/**
 * Assigns a Reserved IPv6 to a droplet. Changing `dropletId` moves the
 * address; destroying the assignment unassigns it.
 *
 * ### Assigning a Reserved IPv6
 * **Example:** Point the address at a droplet
 * ```typescript
 * const ip = yield* DigitalOcean.ReservedIpv6("app-ipv6", { region: "nyc3" });
 * const host = yield* DigitalOcean.Droplet("app", {
 *   region: "nyc3",
 *   size: "s-1vcpu-1gb",
 *   image: "ubuntu-24-04-x64",
 *   ipv6: true,
 * });
 * yield* DigitalOcean.ReservedIpv6Assignment("app-ipv6-on-app", {
 *   ip: ip.ip,
 *   dropletId: host.dropletId,
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Reserved-IPv6-Actions
 *
 * @resource
 * @product Reserved IPs
 * @category Networking
 */
export const ReservedIpv6Assignment = Resource<ReservedIpv6Assignment>(
  "DigitalOcean.ReservedIpv6Assignment",
);

const assignedDropletId = (ip: string) =>
  observeReservedIpv6(ip).pipe(
    Effect.map((observed) => Option.flatMapNullishOr(observed, (r) => r.droplet?.id)),
  );

const waitForAssignment = (ip: string, dropletId: number | undefined) =>
  pollUntil(assignedDropletId(ip), {
    ...RESERVED_IPV6_POLL,
    until: (assigned) =>
      dropletId === undefined ? Option.isNone(assigned) : Option.contains(assigned, dropletId),
    onTimeout: () =>
      new ReservedIpv6WaitTimedOut({
        ip,
        waitingFor: dropletId === undefined ? "unassignment" : `assignment to ${dropletId}`,
      }),
  });

export const ReservedIpv6AssignmentProvider = () =>
  Provider.succeed(ReservedIpv6Assignment, {
    stables: ["ip"],
    read: Effect.fn(function* ({ olds, output }) {
      const ip = output?.ip ?? olds.ip;
      const dropletId = yield* assignedDropletId(ip);
      return Option.getOrUndefined(Option.map(dropletId, (id) => ({ ip, dropletId: id })));
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!("ip" in news) || !isResolved(news.ip) || news.ip !== olds.ip) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const current = yield* assignedDropletId(news.ip);
      if (!Option.contains(current, news.dropletId)) {
        yield* DO.postReservedIPv6Action({
          reserved_ipv6: news.ip,
          body: { type: "assign", droplet_id: news.dropletId },
        });
        yield* waitForAssignment(news.ip, news.dropletId);
      }
      return { ip: news.ip, dropletId: news.dropletId };
    }),
    delete: Effect.fn(function* ({ output }) {
      const current = yield* assignedDropletId(output.ip);
      if (!Option.contains(current, output.dropletId)) return;
      yield* DO.postReservedIPv6Action({
        reserved_ipv6: output.ip,
        body: { type: "unassign" },
      }).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitForAssignment(output.ip, undefined);
    }),
  });
