import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import {
  DnsLookups,
  DnsQueryFailed,
  waitForAuthoritativeRecord,
  waitForSwitchboardDns,
} from "../../../prisma/src/internal/AuthoritativeDns.ts";

const SWITCHBOARD = "switchboard.cdg.prisma.build";
const SWITCHBOARD_IP = "198.51.100.7";
const NS1 = "192.0.2.1";
const NS2 = "192.0.2.2";

type Answer = ReadonlyArray<string> | { readonly code: string };

/**
 * In-memory DNS. `recursive` keys are `"<type> <name>"`; a missing key is
 * NXDOMAIN. `servers` keys are `"<server> <type> <name>"`; a missing key is
 * an answer with no such record.
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
      return "code" in found
        ? Effect.fail(new DnsQueryFailed({ code: found.code }))
        : Effect.succeed(found);
    });
  const lookups: DnsLookups = {
    recursive: (type, name) =>
      answer(`${type} ${name}`, zone.recursive[`${type} ${name}`], "ENOTFOUND"),
    authoritative: (server, type, name) =>
      answer(`${server} ${type} ${name}`, zone.servers[`${server} ${type} ${name}`], "ENODATA"),
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

const switchboardDns = (dns: ReturnType<typeof fakeDns>, name: string) =>
  waitForSwitchboardDns(
    { name, switchboard: SWITCHBOARD },
    { margin: "if-unseen", nameservers: "name" },
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
    "finds a record's nameservers from its parent, never asking about the name itself",
    () =>
      Effect.gen(function* () {
        const name = "_prisma-verification.example.com";
        const dns = exampleZone(onBoth({ [`TXT ${name}`]: ["prisma-verification=abc"] }));

        const visibility = yield* waitForAuthoritativeRecord(
          { type: "TXT", name, value: "prisma-verification=abc" },
          { margin: "if-unseen", nameservers: "parent" },
        ).pipe(Effect.provideService(DnsLookups, dns.lookups));

        expect(visibility).toBe("seen");
        expect(
          dns.asked.filter((query) => query.startsWith("NS ") || query.startsWith("CNAME ")),
        ).toEqual(["NS example.com"]);
      }),
  );

  it.effect("reports a record unknown for an apex searched from its parent", () =>
    Effect.gen(function* () {
      const dns = exampleZone(onBoth({ "CNAME example.com": [SWITCHBOARD] }));

      const visibility = yield* waitForAuthoritativeRecord(
        { type: "CNAME", name: "example.com" },
        { margin: "if-unseen", nameservers: "parent" },
      ).pipe(Effect.provideService(DnsLookups, dns.lookups));

      expect(visibility).toBe("unknown");
      expect(dns.asked).not.toContain("NS example.com");
    }),
  );
});
