import { isTransientError } from "@distilled.cloud/core/category";
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
    name: string;
    /** `"waiting"` while rules propagate to droplets, then `"succeeded"`. */
    status: FirewallStatus;
    dropletIds: number[];
    tags: string[];
    inboundRules: FirewallInboundRule[];
    outboundRules: FirewallOutboundRule[];
    createdAt: string;
  },
  never,
  Providers
>;

/**
 * A DigitalOcean Cloud Firewall — a free, network-level allowlist applied to
 * droplets by id or tag. Traffic not matched by a rule is dropped. Unlike
 * droplets, every aspect updates in place: the API takes a full desired
 * representation via PUT and resets anything omitted, which is exactly the
 * declarative contract reconcile wants.
 * @resource
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

/** Allow all outbound traffic — the default when `outboundRules` is omitted. */
const ALLOW_ALL_OUTBOUND: FirewallOutboundRule[] = [
  { protocol: "tcp", ports: "0", addresses: ["0.0.0.0/0", "::/0"] },
  { protocol: "udp", ports: "0", addresses: ["0.0.0.0/0", "::/0"] },
  { protocol: "icmp", ports: "0", addresses: ["0.0.0.0/0", "::/0"] },
];

const asStrings = (u: unknown): string[] =>
  Array.isArray(u) ? u.filter((x): x is string => typeof x === "string") : [];

/** ICMP has no ports; the API reports `"0"` regardless of what was sent. */
const normalizePorts = (protocol: FirewallRuleProtocol, ports: string) =>
  protocol === "icmp" ? "0" : ports;

const toInboundRule = (
  rule: FirewallInboundRulesItem,
): FirewallInboundRule => ({
  protocol: rule.protocol,
  ports: rule.ports,
  addresses: [...(rule.sources.addresses ?? [])],
  dropletIds: [...(rule.sources.droplet_ids ?? [])],
  tags: asStrings(rule.sources.tags),
});

const toOutboundRule = (
  rule: FirewallOutboundRulesItem,
): FirewallOutboundRule => ({
  protocol: rule.protocol,
  ports: rule.ports,
  addresses: [...(rule.destinations.addresses ?? [])],
  dropletIds: [...(rule.destinations.droplet_ids ?? [])],
  tags: asStrings(rule.destinations.tags),
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
 * Order-insensitive rule-set fingerprint. Rules are canonicalized (icmp
 * ports collapse to "0", member lists sort, empty lists and omissions
 * coincide) so prop-vs-prop and prop-vs-observed comparisons both work.
 * Addresses compare verbatim — write CIDRs canonically (`"0.0.0.0/0"`,
 * `"::/0"`) as DigitalOcean echoes them back unchanged.
 */
const canonRules = (rules: Array<FirewallInboundRule | FirewallOutboundRule>) =>
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
) => canonRules(a ?? []) === canonRules(b ?? []);

const sameNumberSet = (
  a: ReadonlyArray<number> | undefined,
  b: ReadonlyArray<number> | undefined,
) => {
  const sa = [...(a ?? [])].sort((x, y) => x - y);
  const sb = [...(b ?? [])].sort((x, y) => x - y);
  return sa.length === sb.length && sa.every((x, i) => x === sb[i]);
};

const sameStringSet = (
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
) => {
  const sa = [...(a ?? [])].sort();
  const sb = [...(b ?? [])].sort();
  return sa.length === sb.length && sa.every((x, i) => x === sb[i]);
};

/** Rules have propagated to every assigned droplet. */
const isApplied = (firewall: ApiFirewall) =>
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
        firewallId: firewall.id ?? "",
        name: firewall.name ?? "",
        status: firewall.status ?? ("waiting" as FirewallStatus),
        dropletIds: [...(firewall.droplet_ids ?? [])],
        tags: asStrings(firewall.tags),
        inboundRules: (firewall.inbound_rules ?? []).map(toInboundRule),
        outboundRules: (firewall.outbound_rules ?? []).map(toOutboundRule),
        createdAt: firewall.created_at ?? "",
      });

      const observe = (firewallId: string) =>
        get({ firewall_id: firewallId }).pipe(
          Effect.map((r) => Option.fromNullishOr(r.firewall)),
          Effect.catchTag("NotFound", () => Effect.succeedNone),
        );

      const listAll = Effect.gen(function* () {
        const out: ApiFirewall[] = [];
        for (let page = 1; ; page++) {
          const res = yield* list({ per_page: 200, page });
          const firewalls = res.firewalls ?? [];
          out.push(...firewalls);
          if (firewalls.length < 200) return out;
        }
      });

      /**
       * Firewall names are not unique and firewalls cannot carry marker
       * tags (their `tags` prop *assigns* droplet-tags, it doesn't label
       * the firewall) — an exact-name match is the only recovery probe.
       */
      const observeByName = (name: string) =>
        listAll.pipe(
          Effect.map((firewalls) =>
            Arr.findFirst(firewalls, (f) => f.name === name),
          ),
        );

      /**
       * Poll on the success channel until `settled` holds, mirroring the
       * droplet lesson: mutations are visible in GET only eventually, and
       * rule propagation to droplets is itself asynchronous
       * (`pending_changes`). `FirewallNotApplied` exists only as the
       * terminal timeout error.
       */
      const waitForFirewall = (
        firewallId: string,
        settled: (firewall: ApiFirewall) => boolean,
      ) =>
        get({ firewall_id: firewallId }).pipe(
          Effect.map((r) => Option.fromNullishOr(r.firewall)),
          Effect.catchIf(isTransientError, () =>
            Effect.succeed(Option.none<ApiFirewall>()),
          ),
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: (firewall) => Option.exists(firewall, settled),
            // ≈ 3 minutes — rule propagation usually takes seconds.
            times: 60,
          }),
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
                        status: firewall.status ?? "unknown",
                      }),
                    ),
            }),
          ),
        );

      return {
        stables: ["firewallId", "createdAt"],
        list: () => listAll.pipe(Effect.map((fs) => fs.map(toAttrs))),
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news) || olds === undefined) return undefined;
          if (
            news.name !== olds.name ||
            !sameNumberSet(news.dropletIds, olds.dropletIds) ||
            !sameStringSet(news.tags, olds.tags) ||
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

          const settledOnDesired = (firewall: ApiFirewall) =>
            isApplied(firewall) &&
            firewall.name === desiredName &&
            sameNumberSet(firewall.droplet_ids ?? [], news.dropletIds) &&
            sameStringSet(asStrings(firewall.tags), news.tags) &&
            sameRules(
              (firewall.inbound_rules ?? []).map(toInboundRule),
              desiredInbound,
            ) &&
            sameRules(
              (firewall.outbound_rules ?? []).map(toOutboundRule),
              desiredOutbound,
            );

          // Observe — cached physical id first, then an exact-name probe so
          // a crash after create converges instead of minting a twin.
          const current = yield* output !== undefined
            ? observe(output.firewallId)
            : observeByName(desiredName);

          // Ensure — POST creates the firewall and begins applying it to
          // any assigned droplets; wait until fully applied.
          if (Option.isNone(current)) {
            const created = yield* create({
              name: desiredName,
              droplet_ids: news.dropletIds,
              tags: news.tags,
              inbound_rules: toApiInbound(desiredInbound),
              outbound_rules: toApiOutbound(desiredOutbound),
            });
            const firewallId = created.firewall?.id;
            if (firewallId === undefined) {
              return yield* Effect.die(
                new Error("firewall create response carried no firewall id"),
              );
            }
            return toAttrs(yield* waitForFirewall(firewallId, isApplied));
          }

          // Sync — PUT takes the full desired representation and resets
          // anything omitted, so one declarative call converges every prop.
          const firewall = current.value;
          const firewallId = firewall.id;
          if (firewallId === undefined) {
            return yield* Effect.die(
              new Error("firewall observe response carried no firewall id"),
            );
          }
          if (!settledOnDesired(firewall)) {
            yield* update({
              firewall_id: firewallId,
              name: desiredName,
              droplet_ids: news.dropletIds,
              tags: news.tags,
              inbound_rules: toApiInbound(desiredInbound),
              outbound_rules: toApiOutbound(desiredOutbound),
            });
            return toAttrs(
              yield* waitForFirewall(firewallId, settledOnDesired),
            );
          }
          return toAttrs(firewall);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* del({ firewall_id: output.firewallId }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
          // Unassignment from droplets is asynchronous — poll until the API
          // answers NotFound so dependents can be torn down cleanly.
          const gone = yield* get({ firewall_id: output.firewallId }).pipe(
            Effect.map(() => false),
            Effect.catchTag("NotFound", () => Effect.succeed(true)),
            Effect.catchIf(isTransientError, () => Effect.succeed(false)),
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (gone) => gone,
              times: 40,
            }),
          );
          if (!gone) {
            return yield* Effect.fail(
              new FirewallStillPresent({ firewallId: output.firewallId }),
            );
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          if (output !== undefined) {
            const existing = yield* observe(output.firewallId);
            return Option.getOrUndefined(Option.map(existing, toAttrs));
          }
          // Name match without cached state: names are not unique and carry
          // no ownership proof — surface as Unowned so a takeover needs an
          // explicit `--adopt`.
          if (olds?.name === undefined) return undefined;
          const existing = yield* observeByName(olds.name);
          return Option.getOrUndefined(
            Option.map(existing, (firewall) => Unowned(toAttrs(firewall))),
          );
        }),
      };
    }),
  );
