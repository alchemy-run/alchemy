import {
  firewallsCreate,
  firewallsDelete,
  firewallsGet,
  firewallsList,
  firewallsUpdate,
  type Firewall as ApiFirewall,
  type FirewallInboundRulesItem,
  type FirewallOutboundRulesItem,
  type FirewallStatus,
} from "@distilled.cloud/digitalocean/firewalls";
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { sameElements } from "../../Util/equal.ts";
import { listAllPages } from "../paginate.ts";
import type { Providers } from "../Providers.ts";

export type FirewallRuleProtocol = "tcp" | "udp" | "icmp";

export type FirewallInboundRule = {
  protocol: FirewallRuleProtocol;
  /**
   * Single port (`"22"`), range (`"8000-9000"`), or `"0"` for all ports.
   * ICMP has no ports — the API always reports `"0"` for it.
   */
  ports: string;
  /** IPv4/IPv6 addresses and CIDRs allowed in, e.g. `"0.0.0.0/0"`, `"::/0"`. */
  addresses?: string[];
  /** Droplet ids allowed in. */
  dropletIds?: number[];
  /** Droplet tags allowed in. */
  tags?: string[];
};

export type FirewallOutboundRule = {
  protocol: FirewallRuleProtocol;
  /** Single port (`"443"`), range, or `"0"` for all ports. */
  ports: string;
  /** IPv4/IPv6 addresses and CIDRs allowed out. */
  addresses?: string[];
  /** Droplet ids allowed out. */
  dropletIds?: number[];
  /** Droplet tags allowed out. */
  tags?: string[];
};

export type FirewallProps = {
  /**
   * Display name (alphanumeric plus `.` and `-`). Defaults to a generated
   * physical name. Every property, name included, updates in place.
   */
  name?: string;
  /** Droplet ids the firewall protects. */
  dropletIds?: number[];
  /** Droplet tags the firewall protects (all droplets carrying the tag). */
  tags?: string[];
  /** Inbound allow rules. Traffic not matched by any rule is dropped. */
  inboundRules?: FirewallInboundRule[];
  /**
   * Outbound allow rules. Omitted means allow all outbound traffic — the
   * almost-universal intent, and without it a droplet cannot even resolve
   * DNS or pull images. Pass `[]` to deliberately drop all outbound.
   */
  outboundRules?: FirewallOutboundRule[];
};

export type Firewall = Resource<
  "DigitalOcean.Firewall",
  FirewallProps,
  {
    firewallId: string;
    /** Display name. */
    name: string;
    /** `"waiting"` while rules propagate to droplets, then `"succeeded"`. */
    status: FirewallStatus;
    /** Droplet ids the firewall protects. */
    dropletIds: number[];
    /** Droplet tags the firewall protects. */
    tags: string[];
    /** Inbound allow rules. */
    inboundRules: FirewallInboundRule[];
    /** Outbound allow rules (allow-all when the prop was omitted). */
    outboundRules: FirewallOutboundRule[];
    /** ISO8601 creation timestamp. */
    createdAt: string;
  },
  never,
  Providers
>;

/**
 * A DigitalOcean Cloud Firewall — a free, network-level allowlist applied
 * to droplets by id or tag. Traffic not matched by a rule is dropped.
 * Every aspect updates in place: the API's PUT takes the full desired
 * representation and resets anything omitted — exactly the declarative
 * contract reconcile wants.
 *
 * Ownership: firewalls carry no ownership markers (their `tags` prop
 * assigns droplet-tags, it doesn't label the firewall), so a same-named
 * match without prior state surfaces as `Unowned` and requires `--adopt`.
 *
 * @resource
 * @product Firewalls
 * @category Networking
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Firewalls
 *
 * @section Creating a Firewall
 * @example Lock a web host down to SSH + HTTP(S)
 * ```typescript
 * const host = yield* DigitalOcean.Droplet("app", {
 *   region: "sfo3",
 *   size: "s-2vcpu-4gb",
 *   image: "docker-24-04",
 * });
 * yield* DigitalOcean.Firewall("edge", {
 *   dropletIds: [host.dropletId],
 *   inboundRules: [
 *     { protocol: "tcp", ports: "22", addresses: ["0.0.0.0/0", "::/0"] },
 *     { protocol: "tcp", ports: "80", addresses: ["0.0.0.0/0", "::/0"] },
 *     { protocol: "tcp", ports: "443", addresses: ["0.0.0.0/0", "::/0"] },
 *   ],
 *   // outboundRules omitted — allow all outbound.
 * });
 * ```
 */
export const Firewall = Resource<Firewall>("DigitalOcean.Firewall");

class FirewallNotApplied extends Data.TaggedError("FirewallNotApplied")<{
  readonly firewallId: string;
  readonly status: string;
}> {}

class FirewallStillPresent extends Data.TaggedError("FirewallStillPresent")<{
  readonly firewallId: string;
}> {}

class FirewallExistsUnowned extends Data.TaggedError("FirewallExistsUnowned")<{
  readonly name: string;
  readonly firewallId: string;
}> {
  override get message() {
    return `A firewall named "${this.name}" (${this.firewallId}) already exists and cannot be proven ours. Re-deploy with --adopt to take it over, or pick a different name.`;
  }
}

/** Allow all outbound traffic — the default when `outboundRules` is omitted. */
const ALLOW_ALL_OUTBOUND: FirewallOutboundRule[] = [
  { protocol: "tcp", ports: "0", addresses: ["0.0.0.0/0", "::/0"] },
  { protocol: "udp", ports: "0", addresses: ["0.0.0.0/0", "::/0"] },
  { protocol: "icmp", ports: "0", addresses: ["0.0.0.0/0", "::/0"] },
];

// The generated tag-array type is `unknown[]` (spec oneOf).
const stringsOnly = (u: unknown): string[] =>
  Array.isArray(u) ? u.filter((x): x is string => typeof x === "string") : [];

/** ICMP has no ports; the API reports `"0"` regardless of what was sent. */
const normalizePorts = (protocol: FirewallRuleProtocol, ports: string) =>
  protocol === "icmp" ? "0" : ports;

const fromApiInbound = (
  rule: FirewallInboundRulesItem,
): FirewallInboundRule => ({
  protocol: rule.protocol,
  ports: rule.ports,
  addresses: [...(rule.sources.addresses ?? [])],
  dropletIds: [...(rule.sources.droplet_ids ?? [])],
  tags: stringsOnly(rule.sources.tags),
});

const fromApiOutbound = (
  rule: FirewallOutboundRulesItem,
): FirewallOutboundRule => ({
  protocol: rule.protocol,
  ports: rule.ports,
  addresses: [...(rule.destinations.addresses ?? [])],
  dropletIds: [...(rule.destinations.droplet_ids ?? [])],
  tags: stringsOnly(rule.destinations.tags),
});

const toApiInbound = (rules: FirewallInboundRule[]) =>
  rules.map((rule) => ({
    protocol: rule.protocol,
    ports: normalizePorts(rule.protocol, rule.ports),
    sources: {
      addresses: rule.addresses,
      droplet_ids: rule.dropletIds,
      tags: rule.tags,
    },
  }));

const toApiOutbound = (rules: FirewallOutboundRule[]) =>
  rules.map((rule) => ({
    protocol: rule.protocol,
    ports: normalizePorts(rule.protocol, rule.ports),
    destinations: {
      addresses: rule.addresses,
      droplet_ids: rule.dropletIds,
      tags: rule.tags,
    },
  }));

/**
 * Order-insensitive rule-set fingerprint: icmp ports collapse to "0",
 * member lists sort, omissions and empty lists coincide. Addresses compare
 * verbatim — write CIDRs canonically (`"0.0.0.0/0"`, `"::/0"`), as
 * DigitalOcean echoes them back unchanged.
 */
const fingerprintRules = (
  rules: Array<FirewallInboundRule | FirewallOutboundRule>,
) =>
  rules
    .map((rule) =>
      [
        rule.protocol,
        normalizePorts(rule.protocol, rule.ports),
        [...(rule.addresses ?? [])].sort().join(","),
        [...(rule.dropletIds ?? [])].sort((a, b) => a - b).join(","),
        [...(rule.tags ?? [])].sort().join(","),
      ].join("|"),
    )
    .sort()
    .join(";");

const sameRules = (
  a: Array<FirewallInboundRule | FirewallOutboundRule> | undefined,
  b: Array<FirewallInboundRule | FirewallOutboundRule> | undefined,
) => fingerprintRules(a ?? []) === fingerprintRules(b ?? []);

/** Rules have propagated to every assigned droplet. */
const isSettled = (firewall: ApiFirewall) =>
  firewall.status === "succeeded" &&
  (firewall.pending_changes ?? []).length === 0;

export const FirewallProvider = () =>
  Provider.effect(
    Firewall,
    Effect.gen(function* () {
      const create = yield* firewallsCreate;
      const get = yield* firewallsGet;
      const update = yield* firewallsUpdate;
      const del = yield* firewallsDelete;
      const list = yield* firewallsList;

      const toAttrs = (firewall: ApiFirewall) => ({
        firewallId: firewall.id,
        name: firewall.name,
        status: firewall.status,
        dropletIds: [...(firewall.droplet_ids ?? [])],
        tags: stringsOnly(firewall.tags),
        inboundRules: (firewall.inbound_rules ?? []).map(fromApiInbound),
        outboundRules: (firewall.outbound_rules ?? []).map(fromApiOutbound),
        createdAt: firewall.created_at,
      });

      const observe = (firewallId: string) =>
        get({ firewall_id: firewallId }).pipe(
          Effect.map((r) => Option.some(r.firewall)),
          Effect.catchTag("NotFound", () =>
            Effect.succeed(Option.none<ApiFirewall>()),
          ),
        );

      const listAll = listAllPages((q) =>
        list(q).pipe(Effect.map((r) => r.firewalls ?? [])),
      );

      /**
       * Names are not unique and firewalls cannot carry ownership markers —
       * an exact-name match is the only probe, and it proves nothing.
       */
      const observeByName = (name: string) =>
        listAll.pipe(
          Effect.map((firewalls) =>
            Arr.findFirst(firewalls, (f) => f.name === name),
          ),
        );

      /**
       * Mutations are visible in GET only eventually, and rule propagation
       * to droplets is itself asynchronous (`pending_changes`) — poll on
       * the success channel until `settled` holds. `FirewallNotApplied` is
       * only the terminal timeout.
       */
      const waitForFirewall = (
        firewallId: string,
        settled: (firewall: ApiFirewall) => boolean,
      ) =>
        get({ firewall_id: firewallId }).pipe(
          Effect.map((r) => Option.some(r.firewall)),
          Effect.catchTag("NotFound", () =>
            Effect.succeed(Option.none<ApiFirewall>()),
          ),
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: (firewall) => Option.exists(firewall, settled),
            times: 60,
          }),
          // Exhausting `times` still returns the last value as a success —
          // re-check before conceding.
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new FirewallNotApplied({ firewallId, status: "missing" }),
                ),
              onSome: (firewall) =>
                settled(firewall)
                  ? Effect.succeed(firewall)
                  : Effect.fail(
                      new FirewallNotApplied({
                        firewallId,
                        status: firewall.status,
                      }),
                    ),
            }),
          ),
          Effect.timeoutOrElse({
            duration: "5 minutes",
            orElse: () =>
              new FirewallNotApplied({ firewallId, status: "timed-out" }),
          }),
        );

      return {
        stables: ["firewallId", "createdAt"],
        list: Effect.fn(function* () {
          return (yield* listAll).map(toAttrs);
        }),
        read: Effect.fn(function* ({ olds, output }) {
          if (output !== undefined) {
            const existing = yield* observe(output.firewallId);
            return Option.getOrUndefined(Option.map(existing, toAttrs));
          }
          // A name match without prior state carries no ownership proof.
          if (olds?.name === undefined) return undefined;
          const existing = yield* observeByName(olds.name);
          return Option.getOrUndefined(
            Option.map(existing, (firewall) => Unowned(toAttrs(firewall))),
          );
        }),
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news) || olds === undefined) return undefined;
          if (
            news.name !== olds.name ||
            !sameElements(news.dropletIds, olds.dropletIds) ||
            !sameElements(news.tags, olds.tags) ||
            !sameRules(news.inboundRules, olds.inboundRules) ||
            !sameRules(news.outboundRules, olds.outboundRules)
          ) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const desiredName =
            news.name ?? (yield* createPhysicalName({ id, maxLength: 255 }));
          const desiredInbound = news.inboundRules ?? [];
          const desiredOutbound = news.outboundRules ?? ALLOW_ALL_OUTBOUND;

          const matchesDesired = (firewall: ApiFirewall) =>
            isSettled(firewall) &&
            firewall.name === desiredName &&
            sameElements(firewall.droplet_ids ?? [], news.dropletIds) &&
            sameElements(stringsOnly(firewall.tags), news.tags) &&
            sameRules(
              (firewall.inbound_rules ?? []).map(fromApiInbound),
              desiredInbound,
            ) &&
            sameRules(
              (firewall.outbound_rules ?? []).map(fromApiOutbound),
              desiredOutbound,
            );

          // Observe — cached id, else a name probe for crash-after-create
          // recovery. An auto-generated name embeds the instance id, so a
          // match is ours by construction; an explicit name proves nothing,
          // and mutating an unproven match would rewrite a stranger's
          // firewall — the adoption gate (`read` + --adopt) is the only
          // path to take one over.
          const current = yield* output !== undefined
            ? observe(output.firewallId)
            : observeByName(desiredName);
          if (
            output === undefined &&
            news.name !== undefined &&
            Option.isSome(current)
          ) {
            return yield* new FirewallExistsUnowned({
              name: desiredName,
              firewallId: current.value.id,
            });
          }

          // Ensure — POST begins applying the firewall to any assigned
          // droplets; wait until fully applied.
          if (Option.isNone(current)) {
            const created = yield* create({
              name: desiredName,
              droplet_ids: news.dropletIds,
              tags: news.tags,
              inbound_rules: toApiInbound(desiredInbound),
              outbound_rules: toApiOutbound(desiredOutbound),
            });
            return toAttrs(
              yield* waitForFirewall(created.firewall.id, isSettled),
            );
          }

          // Sync — PUT takes the full desired representation and resets
          // anything omitted: one declarative call converges every prop.
          const firewall = current.value;
          if (!matchesDesired(firewall)) {
            yield* update({
              firewall_id: firewall.id,
              name: desiredName,
              droplet_ids: news.dropletIds,
              tags: news.tags,
              inbound_rules: toApiInbound(desiredInbound),
              outbound_rules: toApiOutbound(desiredOutbound),
            });
            return toAttrs(yield* waitForFirewall(firewall.id, matchesDesired));
          }
          return toAttrs(firewall);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* del({ firewall_id: output.firewallId }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
          // Unassignment from droplets is asynchronous — poll until
          // NotFound so dependents tear down cleanly.
          const gone = yield* get({ firewall_id: output.firewallId }).pipe(
            Effect.map(() => false),
            Effect.catchTag("NotFound", () => Effect.succeed(true)),
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (gone) => gone,
              times: 40,
            }),
            Effect.timeoutOrElse({
              duration: "5 minutes",
              orElse: () => Effect.succeed(false),
            }),
          );
          if (!gone) {
            return yield* new FirewallStillPresent({
              firewallId: output.firewallId,
            });
          }
        }),
      };
    }),
  );
