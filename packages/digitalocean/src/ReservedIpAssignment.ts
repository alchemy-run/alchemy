import * as DO from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { pollUntil, type PollBudget } from "./internal/poll.ts";
import type { Providers } from "./Providers.ts";
import { observeReservedIp, ReservedIpWaitTimedOut } from "./ReservedIp.ts";

export type ReservedIpAssignmentProps = {
  /** The reserved IP address. */
  ip: string;
  /** Droplet in the IP's region. A change moves the IP to the new droplet. */
  dropletId: number;
};

export type ReservedIpAssignment = Resource<
  "DigitalOcean.ReservedIpAssignment",
  ReservedIpAssignmentProps,
  {
    /** The reserved IP address. */
    ip: string;
    /** Droplet the IP is assigned to. */
    dropletId: number;
  },
  never,
  Providers
>;

/**
 * Assigns a Reserved IP to a droplet. Changing `dropletId` moves the IP to
 * the new droplet in one step, so traffic to the address switches without a
 * gap. Destroying the assignment unassigns the IP; the IP stays reserved.
 *
 * ### Assigning a Reserved IP
 * **Example:** Keep one address across droplet replacements
 * ```typescript
 * const ip = yield* DigitalOcean.ReservedIp("app-ip", { region: "sfo3" });
 * const host = yield* DigitalOcean.Droplet("app", {
 *   region: "sfo3",
 *   size: "s-1vcpu-1gb",
 *   image: "ubuntu-24-04-x64",
 *   replaceAfter: "30 days",
 * });
 * // A replaced droplet gets the address as soon as it is up.
 * yield* DigitalOcean.ReservedIpAssignment("app-ip-on-app", {
 *   ip: ip.ip,
 *   dropletId: host.dropletId,
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Reserved-IP-Actions
 *
 * @resource
 * @product Reserved IPs
 * @category Networking
 */
export const ReservedIpAssignment = Resource<ReservedIpAssignment>(
  "DigitalOcean.ReservedIpAssignment",
);

export class ReservedIpActionFailed extends Data.TaggedError(
  "DigitalOcean.ReservedIpActionFailed",
)<{
  readonly ip: string;
  readonly actionId: number;
  readonly status: string;
}> {
  override get message() {
    return `Reserved IP ${this.ip} action ${this.actionId} did not complete (last status: '${this.status}').`;
  }
}

// An assign finishes within seconds; a droplet still booting holds it longer.
const ACTION_POLL: PollBudget = { maxDelay: "5 seconds", times: 30 };

const observeActionStatus = (ip: string, actionId: number) =>
  DO.getReservedIPsAction({ reserved_ip: ip, action_id: actionId }).pipe(
    Effect.map((response) => response.action.status),
    // A 404 on a new action is read lag.
    Effect.catchTag("NotFound", () => Effect.succeed("in-progress" as const)),
  );

const runAction = Effect.fn(function* (ip: string, body: DO.PostReservedIPsActionRequestBody) {
  const posted = yield* DO.postReservedIPsAction({ reserved_ip: ip, body });
  const actionId = posted.action.id;
  const failed = (status: string) => new ReservedIpActionFailed({ ip, actionId, status });
  yield* pollUntil(observeActionStatus(ip, actionId), {
    ...ACTION_POLL,
    until: (status) => status !== "in-progress",
    onTimeout: failed,
  }).pipe(Effect.filterOrFail((status) => status === "completed", failed));
});

const assignedDropletId = (ip: string) =>
  observeReservedIp(ip).pipe(
    Effect.map((observed) => Option.flatMapNullishOr(observed, (r) => r.droplet?.id)),
  );

export const ReservedIpAssignmentProvider = () =>
  Provider.succeed(ReservedIpAssignment, {
    stables: ["ip"],
    read: Effect.fn(function* ({ olds, output }) {
      const ip = output?.ip ?? olds.ip;
      const dropletId = yield* assignedDropletId(ip);
      return Option.getOrUndefined(Option.map(dropletId, (id) => ({ ip, dropletId: id })));
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      // A new droplet moves the IP in place; only a new address replaces.
      if (!("ip" in news) || !isResolved(news.ip) || news.ip !== olds.ip) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const current = yield* assignedDropletId(news.ip);
      // Assigning an assigned IP moves it.
      if (!Option.contains(current, news.dropletId)) {
        yield* runAction(news.ip, { type: "assign", droplet_id: news.dropletId });
        // GET reports the previous droplet for a few seconds after the action completes.
        yield* pollUntil(assignedDropletId(news.ip), {
          ...ACTION_POLL,
          until: (assigned) => Option.contains(assigned, news.dropletId),
          onTimeout: () =>
            new ReservedIpWaitTimedOut({
              ip: news.ip,
              waitingFor: `droplet ${news.dropletId} to report the address`,
            }),
        });
      }
      return { ip: news.ip, dropletId: news.dropletId };
    }),
    delete: Effect.fn(function* ({ output }) {
      const current = yield* assignedDropletId(output.ip);
      if (!Option.contains(current, output.dropletId)) return;
      yield* runAction(output.ip, { type: "unassign" }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
      );
    }),
  });
