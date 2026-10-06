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
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { sameMembers, unique } from "../members.ts";
import { ignoreNotFound, noneIfNotFound } from "../notFound.ts";
import { collectPages } from "../pagination.ts";
import { pollUntil, type PollBudget } from "../poll.ts";
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
   * characters can be letters, digits, `.`, or `-`. A change updates the
   * firewall in place.
   *
   * @default a generated physical name
   */
  name?: string;

  /** Droplet ids the firewall protects. */
  dropletIds?: number[];

  /**
   * Droplet tags the firewall protects. Every droplet with the tag is
   * protected, including droplets created later. Each tag must already
   * exist; DigitalOcean rejects a firewall that names an unknown tag.
   */
  tags?: string[];

  /** Inbound allow rules. Traffic that no rule allows is dropped. */
  inboundRules?: FirewallInboundRule[];

  /**
   * Outbound allow rules. Pass `[]` to drop all outbound traffic.
   *
   * @default all outbound traffic is allowed
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

export type FirewallAttributes = Firewall["Attributes"];

/**
 * A DigitalOcean Cloud Firewall. It allows traffic to droplets selected by
 * id or by tag. Traffic that no rule allows is dropped. Every property
 * updates in place.
 *
 * A firewall has no ownership tag. Its `tags` prop selects droplets; it
 * does not label the firewall. A firewall with the same name but no prior
 * state is `Unowned` and needs `--adopt`.
 *
 * ### Creating a Firewall
 * **Example:** Allow Only SSH, HTTP, and HTTPS to a Web Host
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
 * });
 * ```
 *
 * ### Selecting Droplets by Tag
 * **Example:** Protect Every Droplet That Has a Tag
 * ```typescript
 * yield* DigitalOcean.Firewall("web-tier", {
 *   tags: ["web"],
 *   inboundRules: [
 *     { protocol: "tcp", ports: "443", addresses: ["0.0.0.0/0", "::/0"] },
 *   ],
 *   outboundRules: [],
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Firewalls
 *
 * @resource
 * @product Firewalls
 * @category Networking
 */
export const Firewall = Resource<Firewall>("DigitalOcean.Firewall");

export class FirewallWaitTimedOut extends Data.TaggedError("FirewallWaitTimedOut")<{
  readonly firewallId: string;
  readonly waitingFor: string;
  readonly lastStatus: FirewallStatus | undefined;
}> {
  override get message() {
    return `Firewall ${this.firewallId} did not show ${this.waitingFor} in time (last status: ${this.lastStatus ?? "missing"}).`;
  }
}

export class FirewallApplyFailed extends Data.TaggedError("FirewallApplyFailed")<{
  readonly firewallId: string;
}> {
  override get message() {
    return `DigitalOcean failed to apply firewall ${this.firewallId} to its droplets.`;
  }
}

export class FirewallStillExists extends Data.TaggedError("FirewallStillExists")<{
  readonly firewallId: string;
}> {
  override get message() {
    return `Firewall ${this.firewallId} still exists after delete.`;
  }
}

const NAME_MAX_LENGTH = 255;

// Rules reach the droplets within seconds.
const FIREWALL_POLL: PollBudget = { every: "3 seconds", times: 20 };

const EVERYWHERE = ["0.0.0.0/0", "::/0"];

const ALLOW_ALL_OUTBOUND: FirewallOutboundRule[] = [
  { protocol: "tcp", ports: "0", addresses: EVERYWHERE },
  { protocol: "udp", ports: "0", addresses: EVERYWHERE },
  { protocol: "icmp", ports: "0", addresses: EVERYWHERE },
];

type FirewallRule = FirewallInboundRule | FirewallOutboundRule;

const normalizePorts = (rule: FirewallRule): FirewallRulePorts =>
  rule.protocol === "icmp" ? "0" : rule.ports;

// The SDK types `ports` as `string`.
const parsePorts = (ports: string): FirewallRulePorts => {
  const [from, to] = ports.split("-").map(Number);
  return to === undefined ? `${from}` : `${from}-${to}`;
};

const ascending = (a: number, b: number) => a - b;

// Addresses compare as written, because DigitalOcean returns them unchanged.
const fingerprintRule = (rule: FirewallRule) =>
  [
    rule.protocol,
    normalizePorts(rule),
    unique(rule.addresses).sort().join(","),
    unique(rule.dropletIds).sort(ascending).join(","),
    unique(rule.tags).sort().join(","),
  ].join("|");

/**
 * True when both lists allow the same traffic. Rule order, member order
 * and repeats do not matter.
 *
 * @internal exported for unit testing
 */
export const sameRules = (
  a: ReadonlyArray<FirewallRule> | undefined,
  b: ReadonlyArray<FirewallRule> | undefined,
) => sameMembers(a?.map(fingerprintRule), b?.map(fingerprintRule));

const uniqueRules = (rules: ReadonlyArray<FirewallRule>) =>
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

const inboundRulesOf = (firewall: ApiFirewall): FirewallInboundRule[] =>
  (firewall.inbound_rules ?? []).map((rule) => fromApiRule(rule, rule.sources));

const outboundRulesOf = (firewall: ApiFirewall): FirewallOutboundRule[] =>
  (firewall.outbound_rules ?? []).map((rule) => fromApiRule(rule, rule.destinations));

const toApiRule = (rule: FirewallRule) => ({
  protocol: rule.protocol,
  ports: normalizePorts(rule),
});

const toApiTarget = (rule: FirewallRule) => ({
  addresses: rule.addresses && unique(rule.addresses),
  droplet_ids: rule.dropletIds && unique(rule.dropletIds),
  tags: rule.tags && unique(rule.tags),
});

interface DesiredFirewall {
  readonly name: string;
  readonly dropletIds: ReadonlyArray<number>;
  readonly tags: ReadonlyArray<string>;
  readonly inboundRules: ReadonlyArray<FirewallInboundRule>;
  readonly outboundRules: ReadonlyArray<FirewallOutboundRule>;
}

const desiredFirewall = (name: string, props: FirewallProps): DesiredFirewall => ({
  name,
  dropletIds: unique(props.dropletIds),
  tags: unique(props.tags),
  inboundRules: uniqueRules(props.inboundRules ?? []),
  outboundRules: uniqueRules(props.outboundRules ?? ALLOW_ALL_OUTBOUND),
});

const toApiBody = (desired: DesiredFirewall) => ({
  name: desired.name,
  droplet_ids: [...desired.dropletIds],
  tags: [...desired.tags],
  inbound_rules: desired.inboundRules.map((rule) => ({
    ...toApiRule(rule),
    sources: toApiTarget(rule),
  })),
  outbound_rules: desired.outboundRules.map((rule) => ({
    ...toApiRule(rule),
    destinations: toApiTarget(rule),
  })),
});

const matches = (desired: DesiredFirewall) => (firewall: ApiFirewall) =>
  firewall.name === desired.name &&
  sameMembers(firewall.droplet_ids, desired.dropletIds) &&
  sameMembers(firewall.tags, desired.tags) &&
  sameRules(inboundRulesOf(firewall), desired.inboundRules) &&
  sameRules(outboundRulesOf(firewall), desired.outboundRules);

const hasPropagated = (firewall: ApiFirewall) =>
  firewall.status === "succeeded" && (firewall.pending_changes ?? []).length === 0;

const hasFailed = (firewall: ApiFirewall) => firewall.status === "failed";

const toAttrs = (firewall: ApiFirewall): FirewallAttributes => ({
  firewallId: firewall.id,
  name: firewall.name,
  status: firewall.status,
  dropletIds: [...(firewall.droplet_ids ?? [])],
  tags: [...(firewall.tags ?? [])],
  inboundRules: inboundRulesOf(firewall),
  outboundRules: outboundRulesOf(firewall),
  createdAt: firewall.created_at,
});

const physicalName = (id: string) => createPhysicalName({ id, maxLength: NAME_MAX_LENGTH });

export const FirewallProvider = () =>
  Provider.effect(
    Firewall,
    Effect.gen(function* () {
      const create = yield* DO.createFirewall;
      const get = yield* DO.getFirewall;
      const update = yield* DO.updateFirewall;
      const deleteFirewall = yield* DO.deleteFirewall;
      const list = yield* DO.listFirewalls;

      const observeById = (firewallId: string) =>
        noneIfNotFound(
          get({ firewall_id: firewallId }).pipe(Effect.map((response) => response.firewall)),
        );

      const listAll = collectPages(list, (response) => response.firewalls ?? []);

      const observeByName = (name: string) =>
        listAll.pipe(Effect.map(Arr.findFirst((firewall) => firewall.name === name)));

      // The stored id is a cache. A generated name contains the instance
      // id, so it finds the firewall without the id. A user-supplied name
      // proves nothing, because firewall names are not unique.
      const observeOwned = Effect.fn(function* (
        firewallId: string | undefined,
        generatedName: string | undefined,
      ) {
        if (firewallId !== undefined) {
          const byId = yield* observeById(firewallId);
          if (Option.isSome(byId)) return byId;
        }
        if (generatedName === undefined) return Option.none<ApiFirewall>();
        return yield* observeByName(generatedName);
      });

      const waitForFirewall = (
        firewallId: string,
        wait: {
          readonly until: (firewall: ApiFirewall) => boolean;
          readonly waitingFor: string;
        },
      ) =>
        pollUntil(observeById(firewallId), {
          ...FIREWALL_POLL,
          until: (observed): observed is Option.Some<ApiFirewall> =>
            Option.isSome(observed) && (hasFailed(observed.value) || wait.until(observed.value)),
          onTimeout: (last) =>
            new FirewallWaitTimedOut({
              firewallId,
              waitingFor: wait.waitingFor,
              lastStatus: Option.getOrUndefined(Option.map(last, (firewall) => firewall.status)),
            }),
        }).pipe(
          Effect.map((observed) => observed.value),
          Effect.filterOrFail(
            (firewall) => !hasFailed(firewall),
            () => new FirewallApplyFailed({ firewallId }),
          ),
        );

      const waitUntilGone = (firewallId: string) =>
        pollUntil(observeById(firewallId), {
          ...FIREWALL_POLL,
          until: Option.isNone,
          onTimeout: () => new FirewallStillExists({ firewallId }),
        });

      const createFirewall = (desired: DesiredFirewall) =>
        create(toApiBody(desired)).pipe(Effect.map((response) => response.firewall));

      const syncFirewall = Effect.fn(function* (firewall: ApiFirewall, desired: DesiredFirewall) {
        if (!matches(desired)(firewall)) {
          yield* update({ firewall_id: firewall.id, ...toApiBody(desired) });
        }
        return yield* waitForFirewall(firewall.id, {
          until: (observed) => hasPropagated(observed) && matches(desired)(observed),
          waitingFor: "its rules on every droplet",
        });
      });

      return {
        stables: ["firewallId", "createdAt"],
        // A firewall carries no ownership marker, so a list cannot tell the
        // firewalls Alchemy created from the rest of the team's.
        nuke: { skip: true },
        list: Effect.fn(function* () {
          return (yield* listAll).map(toAttrs);
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          if (output !== undefined) {
            const observed = yield* observeById(output.firewallId);
            return Option.getOrUndefined(Option.map(observed, toAttrs));
          }
          const name = olds.name ?? (yield* physicalName(id));
          const named = yield* observeByName(name);
          if (Option.isNone(named)) return undefined;
          const attrs = toAttrs(named.value);
          return olds.name === undefined ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const name = news.name ?? (yield* physicalName(id));
          const generatedName = news.name === undefined ? name : undefined;
          const desired = desiredFirewall(name, news);

          const observed = yield* observeOwned(output?.firewallId, generatedName);
          const firewall = yield* Option.match(observed, {
            onNone: () => createFirewall(desired),
            onSome: Effect.succeed,
          });
          return toAttrs(yield* syncFirewall(firewall, desired));
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* ignoreNotFound(deleteFirewall({ firewall_id: output.firewallId }));
          yield* waitUntilGone(output.firewallId);
        }),
      };
    }),
  );
