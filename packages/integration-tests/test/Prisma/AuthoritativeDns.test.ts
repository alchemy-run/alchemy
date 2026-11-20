import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import {
  DnsLookups,
  DnsQueryFailed,
  checkAuthoritativeRecord,
  checkSwitchboardDns,
} from "../../../prisma/src/internal/AuthoritativeDns.ts";

const SWITCHBOARD = "switchboard.cdg.prisma.build";
const SWITCHBOARD_IP = "198.51.100.7";
const NS1 = "192.0.2.1";
const NS2 = "192.0.2.2";

type Answer =
  | ReadonlyArray<string>
  | { readonly code: string }
  | { readonly after: "10 seconds"; readonly answers: ReadonlyArray<string> }
  | "no answer";

/**
 * In-memory DNS. `recursive` keys are `"<type> <name>"`; a missing key is
 * NXDOMAIN. `servers` keys are `"<server> <type> <name>"`; a missing key is
 * an answer with no such record, except that an A or AAAA query for a name
 * with a CNAME answers for the CNAME's target, as an authoritative server does
 * for a target in its own zone.
 */
const fakeDns = (zone: {
  readonly recursive: Record<string, Answer>;
  readonly servers: Record<string, Answer>;
}) => {
  const asked: Array<string> = [];
  const answer = (key: string, answers: Answer | undefined, missing: string) =>
    Effect.suspend(() => {
      asked.push(key);
      const found = answers ?? { code: missing };
      return found === "no answer"
        ? Effect.never
        : "code" in found
          ? Effect.fail(new DnsQueryFailed({ code: found.code }))
          : "after" in found
            ? Effect.as(Effect.sleep(found.after), found.answers)
            : Effect.succeed(found);
    });
  const atServer = (server: string, type: string, name: string): Answer | undefined => {
    const exact = zone.servers[`${server} ${type} ${name}`];
    const cname = zone.servers[`${server} CNAME ${name}`];
    return exact === undefined && (type === "A" || type === "AAAA") && Array.isArray(cname)
      ? atServer(server, type, cname[0]!.replace(/\.$/, ""))
      : exact;
  };
  const lookups: DnsLookups = {
    recursive: (type, name) =>
      answer(`${type} ${name}`, zone.recursive[`${type} ${name}`], "ENOTFOUND"),
    authoritative: (server, type, name) =>
      answer(`${server} ${type} ${name}`, atServer(server, type, name), "ENODATA"),
  };
  return { lookups, asked };
};

/** `example.com` served by two nameservers, and the switchboard's address. */
const exampleZone = (servers: Record<string, Answer>, recursive: Record<string, Answer> = {}) =>
  fakeDns({
    recursive: {
      "NS example.com": ["ns1.dns.test", "ns2.dns.test"],
      "A ns1.dns.test": [NS1],
      "A ns2.dns.test": [NS2],
      [`A ${SWITCHBOARD}`]: [SWITCHBOARD_IP],
      [`AAAA ${SWITCHBOARD}`]: { code: "ENODATA" },
      ...recursive,
    },
    servers,
  });

/** Both nameservers give the same answer. */
const onBoth = (answers: Record<string, Answer>) =>
  Object.fromEntries(
    [NS1, NS2].flatMap((server) =>
      Object.entries(answers).map(([query, answer]) => [`${server} ${query}`, answer]),
    ),
  );

const runWaiting = <A>(effect: Effect.Effect<A>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);
    yield* TestClock.adjust("5 minutes");
    return yield* Fiber.join(fiber);
  });

const switchboardDns = (
  dns: ReturnType<typeof fakeDns>,
  name: string,
  attempts: "until-seen" | "once" = "until-seen",
) =>
  checkSwitchboardDns(
    { name, switchboard: SWITCHBOARD },
    { margin: "if-unseen", nameservers: "name", attempts },
  ).pipe(Effect.provideService(DnsLookups, dns.lookups));

describe("Prisma authoritative DNS checks", { tags: ["unit", "provider:prisma", "local"] }, () => {
  it.effect(
    "sees a CNAME to the switchboard, asking the parent zone for a name that has a CNAME",
    () =>
      Effect.gen(function* () {
        const dns = exampleZone(onBoth({ "CNAME api.example.com": [`${SWITCHBOARD}.`] }), {
          "CNAME api.example.com": [SWITCHBOARD],
        });

        expect(yield* switchboardDns(dns, "api.example.com")).toEqual({
          visibility: "seen",
          cname: "seen",
        });
        expect(dns.asked).not.toContain("NS api.example.com");
        expect(dns.asked).toContain("NS example.com");
      }),
  );

  it.effect("sees an apex with no CNAME by its A answers, finding the apex's own nameservers", () =>
    Effect.gen(function* () {
      const dns = exampleZone(onBoth({ "A example.com": ["203.0.113.9", SWITCHBOARD_IP] }), {
        "CNAME example.com": { code: "ENODATA" },
      });

      expect(yield* switchboardDns(dns, "example.com")).toEqual({
        visibility: "seen",
        cname: "absent",
      });
      expect(dns.asked).toContain("NS example.com");
    }),
  );

  it.effect(
    "waits, then reports absent when no nameserver points the name at the switchboard",
    () =>
      Effect.gen(function* () {
        const dns = exampleZone(onBoth({ "A example.com": ["203.0.113.9"] }), {
          "CNAME example.com": { code: "ENODATA" },
        });

        expect(yield* runWaiting(switchboardDns(dns, "example.com"))).toEqual({
          visibility: "absent",
          cname: "absent",
        });
        expect(dns.asked.filter((query) => query === `${NS1} A example.com`)).toHaveLength(22);
      }),
  );

  it.effect("reports unknown when no authoritative nameserver can be found", () =>
    Effect.gen(function* () {
      const dns = fakeDns({ recursive: {}, servers: {} });

      expect(yield* switchboardDns(dns, "api.example.com")).toEqual({
        visibility: "unknown",
        cname: "unknown",
      });
    }),
  );

  it.effect("reports unknown when the nameservers fail the queries", () =>
    Effect.gen(function* () {
      const dns = exampleZone(
        onBoth({
          "CNAME api.example.com": { code: "ESERVFAIL" },
          "A api.example.com": { code: "ESERVFAIL" },
          "AAAA api.example.com": { code: "ESERVFAIL" },
        }),
      );

      expect(yield* switchboardDns(dns, "api.example.com")).toEqual({
        visibility: "unknown",
        cname: "unknown",
      });
    }),
  );

  it.effect("reports the CNAME absent when only the address lookup could not be checked", () =>
    Effect.gen(function* () {
      const dns = exampleZone(onBoth({ "AAAA api.example.com": { code: "ETIMEOUT" } }));

      expect(yield* switchboardDns(dns, "api.example.com")).toEqual({
        visibility: "unknown",
        cname: "absent",
      });
    }),
  );

  it.effect("sees a matching A answer when the AAAA query to the same nameserver fails", () =>
    Effect.gen(function* () {
      const dns = exampleZone(
        onBoth({
          "A example.com": [SWITCHBOARD_IP],
          "AAAA example.com": { code: "ESERVFAIL" },
        }),
        { "CNAME example.com": { code: "ENODATA" } },
      );

      expect(yield* switchboardDns(dns, "example.com")).toEqual({
        visibility: "seen",
        cname: "absent",
      });
    }),
  );

  it.effect("compares IPv6 answers with the switchboard's IPv6 addresses", () =>
    Effect.gen(function* () {
      const dns = exampleZone(onBoth({ "AAAA example.com": ["2001:db8::7"] }), {
        "CNAME example.com": { code: "ENODATA" },
        [`AAAA ${SWITCHBOARD}`]: ["2001:db8::7"],
      });

      expect((yield* switchboardDns(dns, "example.com")).visibility).toBe("seen");
    }),
  );

  it.effect("reports unknown when the switchboard's own addresses cannot be resolved", () =>
    Effect.gen(function* () {
      const dns = exampleZone(onBoth({ "A example.com": [SWITCHBOARD_IP] }), {
        "CNAME example.com": { code: "ENODATA" },
        [`A ${SWITCHBOARD}`]: { code: "ENOTFOUND" },
        [`AAAA ${SWITCHBOARD}`]: { code: "ENOTFOUND" },
      });

      expect(yield* switchboardDns(dns, "example.com")).toEqual({
        visibility: "unknown",
        cname: "absent",
      });
    }),
  );

  it.effect("reports absent while one nameserver does not yet answer what the other does", () =>
    Effect.gen(function* () {
      const dns = exampleZone({ [`${NS1} CNAME api.example.com`]: [SWITCHBOARD] });

      expect(yield* runWaiting(switchboardDns(dns, "api.example.com"))).toEqual({
        visibility: "absent",
        cname: "absent",
      });
    }),
  );

  it.effect("reports absent when one nameserver answers without it and the other fails", () =>
    Effect.gen(function* () {
      const dns = exampleZone({
        [`${NS2} CNAME api.example.com`]: { code: "ESERVFAIL" },
        [`${NS2} A api.example.com`]: { code: "ESERVFAIL" },
        [`${NS2} AAAA api.example.com`]: { code: "ESERVFAIL" },
      });

      expect(yield* runWaiting(switchboardDns(dns, "api.example.com"))).toEqual({
        visibility: "absent",
        cname: "absent",
      });
    }),
  );

  it.effect(
    "reports absent for a CNAME to another name, even when the A answers hold a switchboard address",
    () =>
      Effect.gen(function* () {
        const dns = exampleZone(
          onBoth({
            "CNAME api.example.com": ["edge.example.com."],
            "A edge.example.com": [SWITCHBOARD_IP],
          }),
          { "CNAME api.example.com": ["edge.example.com"] },
        );

        expect(yield* runWaiting(switchboardDns(dns, "api.example.com"))).toEqual({
          visibility: "absent",
          cname: "absent",
        });
      }),
  );

  it.effect(
    "reports unknown when the switchboard's AAAA lookup fails and no A answer matches",
    () =>
      Effect.gen(function* () {
        const dns = exampleZone(onBoth({ "AAAA example.com": ["2001:db8::7"] }), {
          "CNAME example.com": { code: "ENODATA" },
          [`AAAA ${SWITCHBOARD}`]: { code: "ESERVFAIL" },
        });

        expect(yield* switchboardDns(dns, "example.com")).toEqual({
          visibility: "unknown",
          cname: "absent",
        });
      }),
  );

  it.effect(
    "reports unknown, without asking the parent zone, when the name's NS lookup times out",
    () =>
      Effect.gen(function* () {
        const dns = exampleZone(onBoth({ "CNAME shop.example.com": [SWITCHBOARD] }), {
          "CNAME shop.example.com": { code: "ENODATA" },
          "NS shop.example.com": "no answer",
        });

        expect(yield* runWaiting(switchboardDns(dns, "shop.example.com"))).toEqual({
          visibility: "unknown",
          cname: "unknown",
        });
        expect(dns.asked).not.toContain("NS example.com");
      }),
  );

  it.effect("reports unknown when the name's own CNAME lookup times out", () =>
    Effect.gen(function* () {
      const dns = exampleZone(onBoth({ "CNAME api.example.com": [SWITCHBOARD] }), {
        "CNAME api.example.com": "no answer",
      });

      expect(yield* runWaiting(switchboardDns(dns, "api.example.com"))).toEqual({
        visibility: "unknown",
        cname: "unknown",
      });
      expect(dns.asked.some((query) => query.startsWith("NS "))).toBe(false);
    }),
  );

  it.effect("checks once, without waiting, when asked for one attempt", () =>
    Effect.gen(function* () {
      const dns = exampleZone({}, { "CNAME example.com": { code: "ENODATA" } });

      expect(yield* switchboardDns(dns, "example.com", "once")).toEqual({
        visibility: "absent",
        cname: "absent",
      });
      expect(dns.asked.filter((query) => query === `${NS1} A example.com`)).toHaveLength(1);
    }),
  );

  it.effect("waits for a slow NS lookup when searching from the parent, as it always has", () =>
    Effect.gen(function* () {
      const name = "_prisma-verification.example.com";
      const dns = exampleZone(onBoth({ [`TXT ${name}`]: ["prisma-verification=abc"] }), {
        "NS example.com": { after: "10 seconds", answers: ["ns1.dns.test", "ns2.dns.test"] },
      });

      const visibility = yield* runWaiting(
        checkAuthoritativeRecord(
          { type: "TXT", name, value: "prisma-verification=abc" },
          { margin: "if-unseen", nameservers: "parent" },
        ).pipe(Effect.provideService(DnsLookups, dns.lookups)),
      );

      expect(visibility).toBe("seen");
    }),
  );

  it.effect("moves one label up when a lookup fails while searching from the parent", () =>
    Effect.gen(function* () {
      const name = "_prisma-verification.shop.example.com";
      const dns = exampleZone(onBoth({ [`TXT ${name}`]: ["prisma-verification=abc"] }), {
        "NS shop.example.com": { code: "ESERVFAIL" },
      });

      const visibility = yield* checkAuthoritativeRecord(
        { type: "TXT", name, value: "prisma-verification=abc" },
        { margin: "if-unseen", nameservers: "parent" },
      ).pipe(Effect.provideService(DnsLookups, dns.lookups));

      expect(visibility).toBe("seen");
      expect(dns.asked).toContain("NS example.com");
    }),
  );

  it.effect(
    "finds a record's nameservers from its parent, never asking about the name itself",
    () =>
      Effect.gen(function* () {
        const name = "_prisma-verification.example.com";
        const dns = exampleZone(onBoth({ [`TXT ${name}`]: ["prisma-verification=abc"] }));

        const visibility = yield* checkAuthoritativeRecord(
          { type: "TXT", name, value: "prisma-verification=abc" },
          { margin: "if-unseen", nameservers: "parent" },
        ).pipe(Effect.provideService(DnsLookups, dns.lookups));

        expect(visibility).toBe("seen");
        expect(
          dns.asked.filter((query) => query.startsWith("NS ") || query.startsWith("CNAME ")),
        ).toEqual(["NS example.com"]);
      }),
  );

  it.effect("reports a TXT unknown, not absent, when the hostname's nameserver lookup fails", () =>
    Effect.gen(function* () {
      const name = "_prisma-verification.shop.example.com";
      const dns = exampleZone(onBoth({}), { "NS shop.example.com": { code: "ESERVFAIL" } });

      const visibility = yield* checkAuthoritativeRecord(
        { type: "TXT", name, value: "prisma-verification=abc" },
        {
          margin: "if-unseen",
          nameservers: "name",
          serversOf: "shop.example.com",
          attempts: "once",
        },
      ).pipe(Effect.provideService(DnsLookups, dns.lookups));

      expect(visibility).toBe("unknown");
      expect(dns.asked).not.toContain("NS example.com");
    }),
  );

  it.effect("finds a TXT through the hostname's nameservers, never asking about the TXT name", () =>
    Effect.gen(function* () {
      const name = "_prisma-verification.shop.example.com";
      const dns = exampleZone(onBoth({ [`TXT ${name}`]: ["prisma-verification=abc"] }));

      const visibility = yield* checkAuthoritativeRecord(
        { type: "TXT", name, value: "prisma-verification=abc" },
        {
          margin: "if-unseen",
          nameservers: "name",
          serversOf: "shop.example.com",
          attempts: "once",
        },
      ).pipe(Effect.provideService(DnsLookups, dns.lookups));

      expect(visibility).toBe("seen");
      expect(dns.asked.some((query) => query.endsWith(` ${name}`) && !query.includes("TXT"))).toBe(
        false,
      );
    }),
  );

  it.effect("reports a record unknown for an apex searched from its parent", () =>
    Effect.gen(function* () {
      const dns = exampleZone(onBoth({ "CNAME example.com": [SWITCHBOARD] }));

      const visibility = yield* checkAuthoritativeRecord(
        { type: "CNAME", name: "example.com" },
        { margin: "if-unseen", nameservers: "parent" },
      ).pipe(Effect.provideService(DnsLookups, dns.lookups));

      expect(visibility).toBe("unknown");
      expect(dns.asked).not.toContain("NS example.com");
    }),
  );
});
