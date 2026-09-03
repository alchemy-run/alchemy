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
import { OwnedBySomeoneElse, Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { sameElements } from "../../Util/equal.ts";
import { listAllPages } from "../paginate.ts";
import { pollUntil, pollUntilGone } from "../poll.ts";
import type { Providers } from "../Providers.ts";

export type FirewallRuleProtocol = "tcp" | "udp" | "icmp";

/** Single port (`"22"`), inclusive range (`"8000-9000"`), or `"0"` for all ports. */
export type FirewallRulePorts = `${number}` | `${number}-${number}`;

export type FirewallInboundRule = {
  protocol: FirewallRuleProtocol;
  /** ICMP has no ports — the API always reports `"0"` for it. */
  ports: FirewallRulePorts;
  /** IPv4/IPv6 addresses and CIDRs allowed in, e.g. `"0.0.0.0/0"`, `"::/0"`. */
  addresses?: string[];
  /** Droplet ids allowed in. */
  dropletIds?: number[];
  /** Droplet tags allowed in. */
  tags?: string[];
};

export type FirewallOutboundRule = {
  protocol: FirewallRuleProtocol;
  ports: FirewallRulePorts;
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
   * Outbound allow rules. Omit to allow all outbound traffic. Pass `[]` to
   * drop all outbound traffic.
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
 * Every property updates in place.
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
 *   image: "ubuntu-24-04-x64",
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
 *
 * @section Targeting by tag
 * @example Protect every droplet carrying a tag
 * ```typescript
 * yield* DigitalOcean.Firewall("web-tier", {
 *   tags: ["web"], // covers droplets as they come and go
 *   inboundRules: [
 *     { protocol: "tcp", ports: "443", addresses: ["0.0.0.0/0", "::/0"] },
 *   ],
 *   outboundRules: [], // deliberately drop all outbound
 * });
 * ```
 */
export const Firewall = Resource<Firewall>("DigitalOcean.Firewall");

class FirewallNotApplied extends Data.TaggedError("FirewallNotApplied")<{
  readonly firewallId: string;
  readonly status: string;
}> {
  override get message() {
    return `Firewall ${this.firewallId} did not finish applying its rules (last status: ${this.status}).`;
  }
}

class FirewallStillPresent extends Data.TaggedError("FirewallStillPresent")<{
  readonly firewallId: string;
}> {
  override get message() {
    return `Firewall ${this.firewallId} still exists after delete.`;
  }
}

/** Allow all outbound traffic — the default when `outboundRules` is omitted. */
const ALLOW_ALL_OUTBOUND: FirewallOutboundRule[] = [
  { protocol: "tcp", ports: "0", addresses: ["0.0.0.0/0", "::/0"] },
  { protocol: "udp", ports: "0", addresses: ["0.0.0.0/0", "::/0"] },
  { protocol: "icmp", ports: "0", addresses: ["0.0.0.0/0", "::/0"] },
];

// The SDK types firewall tags as unknown[].
const stringTags = (u: unknown): string[] =>
  Array.isArray(u) ? u.filter((x): x is string => typeof x === "string") : [];

const unique = <T>(items: ReadonlyArray<T> | undefined) => [
  ...new Set(items ?? []),
];

const uniqueOrOmitted = <T>(items: ReadonlyArray<T> | undefined) => {
  if (items === undefined) return undefined;
  return unique(items);
};

/** ICMP has no ports; the API reports `"0"` regardless of what was sent. */
const normalizePorts = (
  protocol: FirewallRuleProtocol,
  ports: FirewallRulePorts,
) => (protocol === "icmp" ? "0" : ports);

type FirewallRule = FirewallInboundRule | FirewallOutboundRule;

const fingerprintRule = (rule: FirewallRule) =>
  [
    rule.protocol,
    normalizePorts(rule.protocol, rule.ports),
    unique(rule.addresses).sort().join(","),
    unique(rule.dropletIds)
      .sort((a, b) => a - b)
      .join(","),
    unique(rule.tags).sort().join(","),
  ].join("|");

/**
 * Set fingerprint of a rule list: rule order, member order and repeats do
 * not matter, icmp ports collapse to "0", and omitted member lists equal
 * empty ones. Addresses compare verbatim, as DigitalOcean echoes them
 * back unchanged.
 *
 * @internal exported for unit testing
 */
export const fingerprintRules = (rules: ReadonlyArray<FirewallRule>) =>
  unique(rules.map(fingerprintRule)).sort().join(";");

/** @internal exported for unit testing */
export const sameRules = (
  a: ReadonlyArray<FirewallRule> | undefined,
  b: ReadonlyArray<FirewallRule> | undefined,
) => fingerprintRules(a ?? []) === fingerprintRules(b ?? []);

const dedupeRules = <R extends FirewallRule>(rules: ReadonlyArray<R>): R[] => {
  const seen = new Set<string>();
  const out: R[] = [];
  for (const rule of rules) {
    const key = fingerprintRule(rule);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rule);
  }
  return out;
};

const fromApiInbound = (
  rule: FirewallInboundRulesItem,
): FirewallInboundRule => ({
  protocol: rule.protocol,
  ports: rule.ports as FirewallRulePorts,
  addresses: [...(rule.sources.addresses ?? [])],
  dropletIds: [...(rule.sources.droplet_ids ?? [])],
  tags: stringTags(rule.sources.tags),
});

const fromApiOutbound = (
  rule: FirewallOutboundRulesItem,
): FirewallOutboundRule => ({
  protocol: rule.protocol,
  ports: rule.ports as FirewallRulePorts,
  addresses: [...(rule.destinations.addresses ?? [])],
  dropletIds: [...(rule.destinations.droplet_ids ?? [])],
  tags: stringTags(rule.destinations.tags),
});

const toApiInbound = (rules: ReadonlyArray<FirewallInboundRule>) =>
  dedupeRules(rules).map((rule) => ({
    protocol: rule.protocol,
    ports: normalizePorts(rule.protocol, rule.ports),
    sources: {
      addresses: uniqueOrOmitted(rule.addresses),
      droplet_ids: uniqueOrOmitted(rule.dropletIds),
      tags: uniqueOrOmitted(rule.tags),
    },
  }));

const toApiOutbound = (rules: ReadonlyArray<FirewallOutboundRule>) =>
  dedupeRules(rules).map((rule) => ({
    protocol: rule.protocol,
    ports: normalizePorts(rule.protocol, rule.ports),
    destinations: {
      addresses: uniqueOrOmitted(rule.addresses),
      droplet_ids: uniqueOrOmitted(rule.dropletIds),
      tags: uniqueOrOmitted(rule.tags),
    },
  }));

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
        tags: stringTags(firewall.tags),
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

      const listAll = listAllPages(list, (r) => r.firewalls ?? []);

      // Firewall names are not unique.
      const observeByName = (name: string) =>
        listAll.pipe(
          Effect.map((firewalls) =>
            Arr.findFirst(firewalls, (f) => f.name === name),
          ),
        );

      const waitForFirewall = (
        firewallId: string,
        settled: (firewall: ApiFirewall) => boolean,
      ) =>
        pollUntil(observe(firewallId), settled, {
          every: "3 seconds",
          times: 60,
          timeout: "5 minutes",
          notSettled: (last) =>
            new FirewallNotApplied({
              firewallId,
              status: Option.match(last, {
                onNone: () => "missing",
                onSome: (firewall) => firewall.status,
              }),
            }),
        });

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
          // A firewall has no field for an ownership mark. A name match
          // gives no proof that the firewall is ours.
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
            !sameRules(
              news.outboundRules ?? ALLOW_ALL_OUTBOUND,
              olds.outboundRules ?? ALLOW_ALL_OUTBOUND,
            )
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
          const desired = {
            name: desiredName,
            droplet_ids: uniqueOrOmitted(news.dropletIds),
            tags: uniqueOrOmitted(news.tags),
            inbound_rules: toApiInbound(desiredInbound),
            outbound_rules: toApiOutbound(desiredOutbound),
          };

          const matchesDesired = (firewall: ApiFirewall) =>
            isSettled(firewall) &&
            firewall.name === desiredName &&
            sameElements(firewall.droplet_ids ?? [], news.dropletIds) &&
            sameElements(stringTags(firewall.tags), news.tags) &&
            sameRules(
              (firewall.inbound_rules ?? []).map(fromApiInbound),
              desiredInbound,
            ) &&
            sameRules(
              (firewall.outbound_rules ?? []).map(fromApiOutbound),
              desiredOutbound,
            );

          const current =
            output === undefined
              ? yield* observeByName(desiredName)
              : yield* observe(output.firewallId);

          // A generated name contains the instance id, so a match on it is
          // ours. An explicit name gives no proof of ownership.
          if (
            output === undefined &&
            news.name !== undefined &&
            Option.isSome(current)
          ) {
            return yield* new OwnedBySomeoneElse({
              message:
                `Firewall '${desiredName}' (${current.value.id}) already ` +
                "exists and cannot be proven ours. Pick a different `name`, " +
                "or re-run with `--adopt` (or `adopt(true)`) to take it over.",
              resourceType: Firewall.Type,
              logicalId: id,
              physicalName: desiredName,
            });
          }

          if (Option.isNone(current)) {
            const created = yield* create(desired);
            return toAttrs(
              yield* waitForFirewall(created.firewall.id, isSettled),
            );
          }

          const firewall = current.value;
          if (matchesDesired(firewall)) return toAttrs(firewall);
          yield* update({ firewall_id: firewall.id, ...desired });
          return toAttrs(yield* waitForFirewall(firewall.id, matchesDesired));
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* del({ firewall_id: output.firewallId }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
          // The API removes the firewall from its droplets asynchronously.
          yield* pollUntilGone(observe(output.firewallId), {
            every: "3 seconds",
            times: 40,
            timeout: "5 minutes",
            stillPresent: () =>
              new FirewallStillPresent({ firewallId: output.firewallId }),
          });
        }),
      };
    }),
  );
