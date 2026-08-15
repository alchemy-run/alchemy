import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as dns from "@distilled.cloud/vercel/dns";
import * as domains from "@distilled.cloud/vercel/domains";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const teamScope = Effect.gen(function* () {
  const { teamId } = yield* Vercel.VercelEnvironment.current;
  return teamId !== undefined ? { teamId } : {};
});

/** Out-of-band read of a record by id (id endpoint is team-agnostic). */
const getRecord = (recordId: string) =>
  dns.getDomainsRecordsByRecordId({ recordId }).pipe(
    Effect.map((r): dns.GetDomainsRecordsByRecordIdResponse | undefined => r),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const expectRecordGone = (recordId: string) =>
  Effect.gen(function* () {
    const gone = yield* getRecord(recordId).pipe(
      Effect.map((r) =>
        r === undefined ? ("gone" as const) : ("found" as const),
      ),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (s) => s === "gone",
        times: 10,
      }),
    );
    expect(gone).toEqual("gone");
  });

const expectDomainGone = (name: string) =>
  Effect.gen(function* () {
    const team = yield* teamScope;
    const gone = yield* domains.getDomain({ domain: name, ...team }).pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (s) => s === "gone",
        times: 10,
      }),
    );
    expect(gone).toEqual("gone");
  });

test.provider(
  "record lifecycle: create, observe, update (id is re-minted), destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const ZONE = "alchemy-vercel-test-dns.example";

      const deployRecord = (value: string, ttl: number) =>
        stack.deploy(
          Effect.gen(function* () {
            const zone = yield* Vercel.Domain("Zone", { name: ZONE });
            const record = yield* Vercel.DnsRecord("Probe", {
              domain: zone,
              type: "TXT",
              name: "probe",
              value,
              ttl,
              comment: "alchemy DnsRecord lifecycle test",
            });
            return { zone, record };
          }),
        );

      const created = yield* deployRecord("hello-alchemy", 60);
      expect(created.record.domain).toEqual(ZONE);
      expect(created.record.type).toEqual("TXT");
      expect(created.record.name).toEqual("probe");
      expect(created.record.value).toEqual("hello-alchemy");
      expect(created.record.ttl).toEqual(60);

      // Out-of-band verification via distilled.
      const observed = yield* getRecord(created.record.recordId);
      expect(observed).toBeDefined();
      expect(observed!.value).toEqual("hello-alchemy");
      expect(observed!.domain).toEqual(ZONE);

      // No-op redeploy keeps the record id.
      const noop = yield* deployRecord("hello-alchemy", 60);
      expect(noop.record.recordId).toEqual(created.record.recordId);

      // Update value + ttl — Vercel mints a NEW record id on update.
      const updated = yield* deployRecord("hello-alchemy-2", 120);
      expect(updated.record.value).toEqual("hello-alchemy-2");
      expect(updated.record.ttl).toEqual(120);
      expect(updated.record.recordId).not.toEqual(created.record.recordId);

      const observedUpdated = yield* getRecord(updated.record.recordId);
      expect(observedUpdated).toBeDefined();
      expect(observedUpdated!.value).toEqual("hello-alchemy-2");

      yield* stack.destroy();
      yield* expectRecordGone(updated.record.recordId);
      yield* expectDomainGone(ZONE);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "replaces the record when it moves to another domain",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const ZONE_A = "alchemy-vercel-test-dns-a.example";
      const ZONE_B = "alchemy-vercel-test-dns-b.example";

      // Keep BOTH zones deployed across the replacement step (a replace
      // that simultaneously removes its old dependency deadlocks the
      // engine — known bug).
      const deployOn = (target: "a" | "b") =>
        stack.deploy(
          Effect.gen(function* () {
            const zoneA = yield* Vercel.Domain("ZoneA", { name: ZONE_A });
            const zoneB = yield* Vercel.Domain("ZoneB", { name: ZONE_B });
            const record = yield* Vercel.DnsRecord("Moved", {
              domain: target === "a" ? zoneA : zoneB,
              type: "CNAME",
              name: "www",
              value: "cname.vercel-dns.com",
            });
            return { zoneA, zoneB, record };
          }),
        );

      const initial = yield* deployOn("a");
      expect(initial.record.domain).toEqual(ZONE_A);

      const replaced = yield* deployOn("b");
      expect(replaced.record.domain).toEqual(ZONE_B);
      expect(replaced.record.recordId).not.toEqual(initial.record.recordId);

      const observed = yield* getRecord(replaced.record.recordId);
      expect(observed).toBeDefined();
      expect(observed!.domain).toEqual(ZONE_B);

      // Old generation's record was deleted from zone A.
      yield* expectRecordGone(initial.record.recordId);

      yield* stack.destroy();
      yield* expectDomainGone(ZONE_A);
      yield* expectDomainGone(ZONE_B);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
