import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";

/** A record Prisma is about to look up. */
export type ExpectedRecord =
  | { readonly type: "CNAME"; readonly name: string; readonly value?: string }
  | { readonly type: "TXT"; readonly name: string; readonly value: string };

/** The platform's `dnsPointsAtSwitchboard` condition for `name`. */
export interface ExpectedSwitchboardDns {
  readonly name: string;
  /** The regional switchboard, such as `switchboard.cdg.prisma.build`. */
  readonly switchboard: string;
}

/**
 * `seen`: every authoritative nameserver shows it. `absent`: one answered
 * without it. `unknown`: no authoritative nameserver was found, or one could
 * not be asked and none answered without it.
 */
export type RecordVisibility = "seen" | "absent" | "unknown";

/** What the authoritative nameservers show for `dnsPointsAtSwitchboard`. */
export interface SwitchboardDnsVisibility {
  /** A CNAME to the switchboard, or A or AAAA answers that include a switchboard address. */
  readonly visibility: RecordVisibility;
  /** A CNAME to the switchboard, alone. */
  readonly cname: RecordVisibility;
}

/**
 * Where the search for a name's authoritative nameservers starts. `parent`
 * asks for the NS records of the name's parent, then its parent, and so on.
 * `name` asks for the name's own NS records first, so a zone apex such as
 * `example.com` finds its zone. It skips that step when the name has a CNAME,
 * because the recursive lookup would follow it into the target's zone, and
 * stops when a lookup fails.
 */
export type NameserverSearch = "parent" | "name";

export interface CheckOptions {
  /**
   * `always` waits a 10-second margin after the record is seen, also after a
   * single check. `if-unseen` skips the margin when the first check already
   * sees the record, i.e. it was published before this deploy reached it.
   */
  readonly margin: "always" | "if-unseen";
  readonly nameservers: NameserverSearch;
  /** `once` checks without waiting for the records to appear. */
  readonly attempts?: "until-seen" | "once";
  /** How long `until-seen` waits for an absent record. @default about a minute */
  readonly waitFor?: Duration.Duration;
  /** Find the nameservers of this name instead of the record's own name. */
  readonly serversOf?: string;
}

export interface SwitchboardCheckOptions extends CheckOptions {
  readonly attempts: "until-seen" | "once";
}

type AuthoritativeQuery = "CNAME" | "TXT" | "A" | "AAAA";

/** A DNS query failed. `ENODATA` and `ENOTFOUND` mean no such record. */
export class DnsQueryFailed extends Data.TaggedError("DnsQueryFailed")<{
  readonly code: string | undefined;
}> {}

const queryFailed = (error: unknown) =>
  new DnsQueryFailed({
    code:
      Predicate.hasProperty(error, "code") && typeof error.code === "string"
        ? error.code
        : undefined,
  });

/** The DNS queries the checks send: `node:dns/promises` outside tests. */
export interface DnsLookups {
  /** Asks this machine's resolver. */
  readonly recursive: (
    type: "NS" | "CNAME" | "A" | "AAAA",
    name: string,
  ) => Effect.Effect<ReadonlyArray<string>, DnsQueryFailed>;
  /** Asks `server` alone. A TXT record's chunks come joined. */
  readonly authoritative: (
    server: string,
    type: AuthoritativeQuery,
    name: string,
  ) => Effect.Effect<ReadonlyArray<string>, DnsQueryFailed>;
}

const nodeDns = Effect.tryPromise({
  try: () => import("node:dns/promises"),
  catch: queryFailed,
});

const nodeDnsLookups: DnsLookups = {
  recursive: (type, name) =>
    nodeDns.pipe(
      Effect.flatMap((dns) =>
        Effect.tryPromise({
          try: () =>
            type === "NS"
              ? dns.resolveNs(name)
              : type === "CNAME"
                ? dns.resolveCname(name)
                : type === "A"
                  ? dns.resolve4(name)
                  : dns.resolve6(name),
          catch: queryFailed,
        }),
      ),
    ),
  authoritative: (server, type, name) =>
    Effect.gen(function* () {
      const dns = yield* nodeDns;
      const resolver = yield* Effect.try({
        try: () => {
          const instance = new dns.Resolver();
          instance.setServers([server]);
          return instance;
        },
        catch: queryFailed,
      });
      return yield* Effect.tryPromise({
        try: () =>
          type === "TXT"
            ? resolver.resolveTxt(name).then((records) => records.map((chunks) => chunks.join("")))
            : type === "CNAME"
              ? resolver.resolveCname(name)
              : type === "A"
                ? resolver.resolve4(name)
                : resolver.resolve6(name),
        catch: queryFailed,
      }).pipe(
        // A timed-out query keeps retrying in c-ares unless cancelled.
        Effect.onInterrupt(() => Effect.sync(() => resolver.cancel())),
      );
    }),
};

export const DnsLookups = Context.Reference<DnsLookups>("@alchemy.run/prisma/DnsLookups", {
  defaultValue: () => nodeDnsLookups,
});

const NEGATIVE_ANSWERS = new Set(["ENODATA", "ENOTFOUND"]);

/** The answers, `[]` for no such record, or `undefined` when the lookup failed. */
const answersOf = (query: Effect.Effect<ReadonlyArray<string>, DnsQueryFailed>) =>
  query.pipe(
    Effect.catchIf(
      (error) => error.code !== undefined && NEGATIVE_ANSWERS.has(error.code),
      () => Effect.succeed([] as ReadonlyArray<string>),
    ),
    Effect.timeout("3 seconds"),
    Effect.orElseSucceed(() => undefined),
  );

const sameName = (a: string, b: string) =>
  a.replace(/\.$/, "").toLowerCase() === b.replace(/\.$/, "").toLowerCase();

const combine = (answers: ReadonlyArray<RecordVisibility>): RecordVisibility =>
  answers.every((answer) => answer === "seen")
    ? "seen"
    : answers.includes("absent")
      ? "absent"
      : "unknown";

/** A failed lookup counts as no nameservers, and the search moves one label up. */
const serversFromParent = (dns: DnsLookups, name: string) =>
  Effect.gen(function* () {
    const labels = name.split(".");
    for (let i = 1; i < labels.length - 1; i++) {
      const names = yield* dns
        .recursive("NS", labels.slice(i).join("."))
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
      const addresses = yield* Effect.forEach(
        names,
        (server) =>
          dns.recursive("A", server).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>)),
        { concurrency: "unbounded" },
      );
      const servers = addresses.flat();
      if (servers.length > 0) return servers;
    }
    return [];
  });

/**
 * Asks this machine's resolver about `name` itself, which may cache "no such
 * name" there for the zone's negative TTL. If Prisma's resolver shares that
 * cache, Prisma cannot see records published at `name` until it expires.
 */
const serversFromName = (dns: DnsLookups, name: string) =>
  Effect.gen(function* () {
    const labels = name.split(".");
    const cnames = yield* answersOf(dns.recursive("CNAME", name));
    if (cnames === undefined) return [];
    for (let i = cnames.length > 0 ? 1 : 0; i < labels.length - 1; i++) {
      const names = yield* answersOf(dns.recursive("NS", labels.slice(i).join(".")));
      if (names === undefined) return [];
      if (names.length === 0) continue;
      const addresses = yield* Effect.forEach(
        names,
        (server) => answersOf(dns.recursive("A", server)),
        { concurrency: "unbounded" },
      );
      return addresses.some((found) => found === undefined)
        ? []
        : addresses.flatMap((found) => found ?? []);
    }
    return [];
  });

const authoritativeServers = (dns: DnsLookups, name: string, search: NameserverSearch) =>
  search === "parent" ? serversFromParent(dns, name) : serversFromName(dns, name);

/**
 * Prisma checks a domain's records through a caching resolver: a lookup that
 * races a just-published record caches NXDOMAIN for the zone's SOA minimum
 * (30 minutes on Cloudflare), failing every retry. Wait (bounded) while
 * the authoritative nameservers answer without the record, then add a margin
 * for anycast edges we cannot see once every one returns it.
 */
const RECHECK_INTERVAL = Duration.seconds(3);
const ANYCAST_MARGIN = Duration.seconds(10);

const waitUntilVisible = <A>(
  check: Effect.Effect<A>,
  visibilityOf: (answer: A) => RecordVisibility,
  margin: CheckOptions["margin"],
  attempts: SwitchboardCheckOptions["attempts"] = "until-seen",
  waitFor: Duration.Duration = Duration.minutes(1),
) =>
  Effect.gen(function* () {
    const first = yield* check;
    if (visibilityOf(first) === "seen" && margin === "if-unseen") return first;
    const last =
      visibilityOf(first) === "absent" && attempts === "until-seen"
        ? yield* check.pipe(
            Effect.repeat({
              schedule: Schedule.spaced(RECHECK_INTERVAL),
              until: (answer) => visibilityOf(answer) !== "absent",
              times: Math.ceil(Duration.toMillis(waitFor) / Duration.toMillis(RECHECK_INTERVAL)),
            }),
          )
        : first;
    if (visibilityOf(last) === "seen") yield* Effect.sleep(ANYCAST_MARGIN);
    return last;
  });

/**
 * Whether every authoritative nameserver for `record.name` returns the record,
 * waiting for it when `attempts` is `until-seen`.
 */
export const checkAuthoritativeRecord = (
  record: ExpectedRecord,
  options: CheckOptions,
): Effect.Effect<RecordVisibility> =>
  Effect.gen(function* () {
    const dns = yield* DnsLookups;
    const servers = yield* authoritativeServers(
      dns,
      options.serversOf ?? record.name,
      options.nameservers,
    );
    if (servers.length === 0) return "unknown";
    const matches = (answer: string) =>
      record.type === "TXT"
        ? answer === record.value
        : record.value === undefined || sameName(answer, record.value);
    const answerOf = (server: string) =>
      answersOf(dns.authoritative(server, record.type, record.name)).pipe(
        Effect.map((answers): RecordVisibility =>
          answers === undefined ? "unknown" : answers.some(matches) ? "seen" : "absent",
        ),
      );
    const check = Effect.forEach(servers, answerOf, { concurrency: "unbounded" }).pipe(
      Effect.map(combine),
    );
    return yield* waitUntilVisible(
      check,
      (visibility) => visibility,
      options.margin,
      options.attempts,
      options.waitFor,
    );
  });

/**
 * Whether every authoritative nameserver for `expected.name` shows it
 * pointing at the switchboard: a CNAME to it, or, with no CNAME, A or AAAA
 * answers that include an address of the switchboard. Waits for it when
 * `attempts` is `until-seen`.
 */
export const checkSwitchboardDns = (
  expected: ExpectedSwitchboardDns,
  options: SwitchboardCheckOptions,
): Effect.Effect<SwitchboardDnsVisibility> =>
  Effect.gen(function* () {
    const unknown = { visibility: "unknown", cname: "unknown" } as const;
    const dns = yield* DnsLookups;
    const servers = yield* authoritativeServers(dns, expected.name, options.nameservers);
    if (servers.length === 0) return unknown;
    const switchboardLookups = yield* Effect.forEach(
      ["A", "AAAA"] as const,
      (type) => answersOf(dns.recursive(type, expected.switchboard)),
      { concurrency: "unbounded" },
    );
    /** Assumes Prisma resolves the switchboard to the addresses this machine does. */
    const switchboardAddresses = new Set(switchboardLookups.flatMap((found) => found ?? []));
    const switchboardResolved =
      switchboardAddresses.size > 0 && !switchboardLookups.includes(undefined);
    const answerOf = (server: string) =>
      Effect.forEach(
        ["CNAME", "A", "AAAA"] as const,
        (type) => answersOf(dns.authoritative(server, type, expected.name)),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map(([cnames, ipv4, ipv6]): SwitchboardDnsVisibility => {
          const cnameSeen = cnames?.some((target) => sameName(target, expected.switchboard));
          const cname = cnames === undefined ? "unknown" : cnameSeen ? "seen" : "absent";
          const otherCname = cnames !== undefined && cnames.length > 0 && !cnameSeen;
          const addressSeen = [ipv4, ipv6].some((addresses) =>
            addresses?.some((address) => switchboardAddresses.has(address)),
          );
          const unanswered =
            !switchboardResolved || [cnames, ipv4, ipv6].some((answers) => answers === undefined);
          return {
            cname,
            visibility: cnameSeen
              ? "seen"
              : otherCname
                ? "absent"
                : addressSeen
                  ? "seen"
                  : unanswered
                    ? "unknown"
                    : "absent",
          };
        }),
      );
    const check = Effect.forEach(servers, answerOf, { concurrency: "unbounded" }).pipe(
      Effect.map((answers): SwitchboardDnsVisibility => ({
        visibility: combine(answers.map((answer) => answer.visibility)),
        cname: combine(answers.map((answer) => answer.cname)),
      })),
    );
    return yield* waitUntilVisible(
      check,
      (answer) => answer.visibility,
      options.margin,
      options.attempts,
      options.waitFor,
    );
  });

/**
 * The record check domain ownerships, custom domains and a RoutingUrl's
 * hostname change run before Prisma looks the record up; tests replace it.
 */
export const AuthoritativeRecordCheck = Context.Reference<typeof checkAuthoritativeRecord>(
  "@alchemy.run/prisma/AuthoritativeRecordCheck",
  { defaultValue: () => checkAuthoritativeRecord },
);

/** The `dnsPointsAtSwitchboard` check `Prisma.RoutingUrl` runs; tests replace it. */
export const SwitchboardDnsCheck = Context.Reference<typeof checkSwitchboardDns>(
  "@alchemy.run/prisma/SwitchboardDnsCheck",
  { defaultValue: () => checkSwitchboardDns },
);
