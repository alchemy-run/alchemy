import * as DO from "@distilled.cloud/digitalocean";
import type {
  Firewall as ApiFirewall,
  FirewallInboundRulesItem,
  FirewallOutboundRulesItem,
  FirewallStatus,
} from "@distilled.cloud/digitalocean";
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { setEquals } from "../../Util/equal.ts";
import { pollUntil, pollUntilGone, type PollOptions } from "../../Util/poll.ts";
import { listAllPages } from "../paginate.ts";
import type { Providers } from "../Providers.ts";

export type FirewallRuleProtocol = "tcp" | "udp" | "icmp";

/** One port (`"22"`), an inclusive range (`"8000-9000"`), or `"0"` for all ports. */
export type FirewallRulePorts = `${number}` | `${number}-${number}`;

export type FirewallInboundRule = {
  protocol: FirewallRuleProtocol;
  /** ICMP has no ports. The API always reports `"0"` for it. */
  ports: FirewallRulePorts;
  /** IPv4 and IPv6 addresses and CIDRs allowed in, for example `"0.0.0.0/0"` and `"::/0"`. */
  addresses?: string[];
  /** Droplet ids allowed in. */
  dropletIds?: number[];
  /** Droplet tags allowed in. */
  tags?: string[];
};

export type FirewallOutboundRule = {
  protocol: FirewallRuleProtocol;
  /** ICMP has no ports. The API always reports `"0"` for it. */
  ports: FirewallRulePorts;
  /** IPv4 and IPv6 addresses and CIDRs allowed out. */
  addresses?: string[];
  /** Droplet ids allowed out. */
  dropletIds?: number[];
  /** Droplet tags allowed out. */
  tags?: string[];
};

export type FirewallProps = {
  /**
   * Display name. It must start with a letter or a digit. The other
   * characters can be letters, digits, `.`, or `-`. Defaults to a generated
   * physical name. A change updates the firewall in place.
   */
  name?: string;
  /** Droplet ids the firewall protects. */
  dropletIds?: number[];
  /** Droplet tags the firewall protects. Every droplet with the tag is protected. */
  tags?: string[];
  /** Inbound allow rules. Traffic that no rule allows is dropped. */
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
    /** Firewall id (UUID). */
    firewallId: string;
    /** Display name. */
    name: string;
    /** `"waiting"` while the rules propagate to the droplets, then `"succeeded"`. */
    status: FirewallStatus;
    /** Droplet ids the firewall protects. */
    dropletIds: number[];
    /** Droplet tags the firewall protects. */
    tags: string[];
    /** Inbound allow rules. */
    inboundRules: FirewallInboundRule[];
    /** Outbound allow rules. Allow-all when the prop was omitted. */
    outboundRules: FirewallOutboundRule[];
    /** ISO 8601 creation time. */
    createdAt: string;
  },
  never,
  Providers
>;

/**
 * A DigitalOcean Cloud Firewall. It allows traffic to droplets selected by
 * id or by tag. Traffic that no rule allows is dropped. Every property
 * updates in place.
 *
 * A firewall has no ownership tag. Its `tags` prop selects droplets; it
 * does not label the firewall. A firewall with the same name but no prior
 * state is `Unowned` and needs `--adopt`.
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Firewalls
 *
 * ### Creating a Firewall
 * **Example:** Allow only SSH, HTTP, and HTTPS to a web host
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
 *   // outboundRules omitted: all outbound traffic is allowed.
 * });
 * ```
 *
 * ### Selecting droplets by tag
 * **Example:** Protect every droplet that has a tag
 * ```typescript
 * yield* DigitalOcean.Firewall("web-tier", {
 *   tags: ["web"], // also applies to droplets created later
 *   inboundRules: [
 *     { protocol: "tcp", ports: "443", addresses: ["0.0.0.0/0", "::/0"] },
 *   ],
 *   outboundRules: [], // drop all outbound traffic
 * });
 * ```
 *
 * @resource
 * @product Firewalls
 * @category Networking
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

const FIREWALL_POLL: PollOptions = { every: "3 seconds", times: 60 };

/** The default when `outboundRules` is omitted. */
const ALLOW_ALL_OUTBOUND: FirewallOutboundRule[] = [
  { protocol: "tcp", ports: "0", addresses: ["0.0.0.0/0", "::/0"] },
  { protocol: "udp", ports: "0", addresses: ["0.0.0.0/0", "::/0"] },
  { protocol: "icmp", ports: "0", addresses: ["0.0.0.0/0", "::/0"] },
];

const unique = <T>(items: ReadonlyArray<T> | undefined) => [
  ...new Set(items ?? []),
];

const uniqueOrOmitted = <T>(items: ReadonlyArray<T> | undefined) => {
  if (items === undefined) return undefined;
  return unique(items);
};

const normalizePorts = (
  protocol: FirewallRuleProtocol,
  ports: FirewallRulePorts,
) => (protocol === "icmp" ? "0" : ports);

// The SDK types `ports` as `string`. Rebuild the value as a port or a range.
const parsePorts = (ports: string): FirewallRulePorts => {
  const [from, to] = ports.split("-").map(Number);
  return ports.includes("-") ? `${from}-${to}` : `${from}`;
};

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
 * Set fingerprint of a rule list. Rule order, member order, and repeats do
 * not matter. ICMP ports collapse to `"0"`. An omitted member list equals
 * an empty one. Addresses compare as written, because DigitalOcean returns
 * them unchanged.
 */
const fingerprintRules = (rules: ReadonlyArray<FirewallRule>) =>
  unique(rules.map(fingerprintRule)).sort().join(";");

/**
 * True when both lists allow the same traffic.
 *
 * @internal
 */
export const sameRules = (
  a: ReadonlyArray<FirewallRule> | undefined,
  b: ReadonlyArray<FirewallRule> | undefined,
) => fingerprintRules(a ?? []) === fingerprintRules(b ?? []);

const uniqueRules = <R extends FirewallRule>(rules: ReadonlyArray<R>): R[] =>
  Arr.dedupeWith(rules, (a, b) => fingerprintRule(a) === fingerprintRule(b));

type ApiRule = FirewallInboundRulesItem | FirewallOutboundRulesItem;
type ApiRuleTarget =
  | FirewallInboundRulesItem["sources"]
  | FirewallOutboundRulesItem["destinations"];

const fromApiRule = (rule: ApiRule, target: ApiRuleTarget): FirewallRule => ({
  protocol: rule.protocol,
  ports: parsePorts(rule.ports),
  addresses: [...(target.addresses ?? [])],
  dropletIds: [...(target.droplet_ids ?? [])],
  tags: [...(target.tags ?? [])],
});

const fromApiInboundRules = (firewall: ApiFirewall): FirewallInboundRule[] =>
  (firewall.inbound_rules ?? []).map((rule) => fromApiRule(rule, rule.sources));

const fromApiOutboundRules = (firewall: ApiFirewall): FirewallOutboundRule[] =>
  (firewall.outbound_rules ?? []).map((rule) =>
    fromApiRule(rule, rule.destinations),
  );

const toApiRules = <Target extends object>(
  rules: ReadonlyArray<FirewallRule>,
  withTarget: (target: {
    addresses: string[] | undefined;
    droplet_ids: number[] | undefined;
    tags: string[] | undefined;
  }) => Target,
) =>
  uniqueRules(rules).map((rule) => ({
    protocol: rule.protocol,
    ports: normalizePorts(rule.protocol, rule.ports),
    ...withTarget({
      addresses: uniqueOrOmitted(rule.addresses),
      droplet_ids: uniqueOrOmitted(rule.dropletIds),
      tags: uniqueOrOmitted(rule.tags),
    }),
  }));

/** The rules have propagated to every assigned droplet. */
const isSettled = (firewall: ApiFirewall) =>
  firewall.status === "succeeded" &&
  (firewall.pending_changes ?? []).length === 0;

export const FirewallProvider = () =>
  Provider.effect(
    Firewall,
    Effect.gen(function* () {
      const create = yield* DO.createFirewall;
      const get = yield* DO.getFirewall;
      const update = yield* DO.updateFirewall;
      const deleteFirewall = yield* DO.deleteFirewall;
      const list = yield* DO.listFirewalls;

      const toAttrs = (firewall: ApiFirewall) => ({
        firewallId: firewall.id,
        name: firewall.name,
        status: firewall.status,
        dropletIds: [...(firewall.droplet_ids ?? [])],
        tags: [...(firewall.tags ?? [])],
        inboundRules: fromApiInboundRules(firewall),
        outboundRules: fromApiOutboundRules(firewall),
        createdAt: firewall.created_at,
      });

      const observeById = (firewallId: string) =>
        get({ firewall_id: firewallId }).pipe(
          Effect.map((response) => Option.some(response.firewall)),
          Effect.catchTag("NotFound", () =>
            Effect.succeed(Option.none<ApiFirewall>()),
          ),
        );

      const listAll = listAllPages(
        list,
        (response) => response.firewalls ?? [],
      );

      // Firewall names are not unique.
      const observeByName = (name: string) =>
        listAll.pipe(
          Effect.map((firewalls) =>
            Arr.findFirst(firewalls, (firewall) => firewall.name === name),
          ),
        );

      const waitForFirewall = (
        firewallId: string,
        settled: (firewall: ApiFirewall) => boolean,
      ) =>
        pollUntil(observeById(firewallId), settled, {
          ...FIREWALL_POLL,
          notSettled: (last) =>
            new FirewallNotApplied({
              firewallId,
              status: Option.match(last, {
                onNone: () => "missing",
                onSome: (firewall) => firewall.status,
              }),
            }),
        });

      const physicalName = (id: string) =>
        createPhysicalName({ id, maxLength: 255 });

      return {
        stables: ["firewallId", "createdAt"],
        list: Effect.fn(function* () {
          return (yield* listAll).map(toAttrs);
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          if (output !== undefined) {
            const existing = yield* observeById(output.firewallId);
            return Option.getOrUndefined(Option.map(existing, toAttrs));
          }
          const name = olds.name ?? (yield* physicalName(id));
          const existing = yield* observeByName(name);
          if (Option.isNone(existing)) return undefined;
          // A generated name contains the instance id, so a match on it is
          // ours. A firewall has no field for an ownership tag, so a match
          // on a user-supplied name gives no proof.
          if (olds.name === undefined) return toAttrs(existing.value);
          return Unowned(toAttrs(existing.value));
        }),
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news) || olds === undefined) return undefined;
          if (
            news.name !== olds.name ||
            !setEquals(news.dropletIds, olds.dropletIds) ||
            !setEquals(news.tags, olds.tags) ||
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
          const desiredName = news.name ?? (yield* physicalName(id));
          const desiredInbound = news.inboundRules ?? [];
          const desiredOutbound = news.outboundRules ?? ALLOW_ALL_OUTBOUND;
          const desired = {
            name: desiredName,
            droplet_ids: uniqueOrOmitted(news.dropletIds),
            tags: uniqueOrOmitted(news.tags),
            inbound_rules: toApiRules(desiredInbound, (sources) => ({
              sources,
            })),
            outbound_rules: toApiRules(desiredOutbound, (destinations) => ({
              destinations,
            })),
          };
          const desiredInboundFingerprint = fingerprintRules(desiredInbound);
          const desiredOutboundFingerprint = fingerprintRules(desiredOutbound);

          const matchesDesired = (firewall: ApiFirewall) =>
            isSettled(firewall) &&
            firewall.name === desiredName &&
            setEquals(firewall.droplet_ids ?? [], news.dropletIds) &&
            setEquals(firewall.tags ?? [], news.tags) &&
            fingerprintRules(fromApiInboundRules(firewall)) ===
              desiredInboundFingerprint &&
            fingerprintRules(fromApiOutboundRules(firewall)) ===
              desiredOutboundFingerprint;

          // A generated name contains the instance id, so a match on it is
          // ours. The engine checks a user-supplied name with `read` before
          // reconcile runs, and firewall names are not unique.
          const observeCurrent = Effect.gen(function* () {
            if (output !== undefined) {
              return yield* observeById(output.firewallId);
            }
            if (news.name === undefined) {
              return yield* observeByName(desiredName);
            }
            return Option.none<ApiFirewall>();
          });
          const current = yield* observeCurrent;

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
          yield* deleteFirewall({ firewall_id: output.firewallId }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
          // The delete call returns before the firewall is gone.
          yield* pollUntilGone(observeById(output.firewallId), {
            ...FIREWALL_POLL,
            stillPresent: () =>
              new FirewallStillPresent({ firewallId: output.firewallId }),
          });
        }),
      };
    }),
  );
