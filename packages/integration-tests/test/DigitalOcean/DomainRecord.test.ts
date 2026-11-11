import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getDomainRecord } from "@distilled.cloud/digitalocean";
import type * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { forgetAttributes, isGone, logLevel, testDomain } from "./support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:domainrecord", "live"];
const LIVE_TIMEOUT = 180_000;

const readRecord = (domain: string, recordId: number) =>
  getDomainRecord({ domain_name: domain, domain_record_id: recordId }).pipe(
    Effect.map((response) => response.domain_record),
  );

// Records take the domain's output, so they wait for the domain.
const withDomain = <A, E, R>(
  name: string,
  records: (domain: Output.Output<string>) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const zone = yield* DigitalOcean.Domain("Zone", { name });
    return yield* records(zone.name);
  });

test.provider(
  "record lifecycle: A record updated in place, replaced on a new type, deleted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const domain = testDomain(stack.stage, "records");

      const created = yield* stack.deploy(
        withDomain(domain, (zone) =>
          DigitalOcean.DomainRecord("Www", {
            domain: zone,
            type: "A",
            name: "www",
            data: "192.0.2.10",
            ttl: 300,
          }),
        ),
      );
      expect(created).toMatchObject({ type: "A", name: "www", data: "192.0.2.10", ttl: 300 });

      const updated = yield* stack.deploy(
        withDomain(domain, (zone) =>
          DigitalOcean.DomainRecord("Www", {
            domain: zone,
            type: "A",
            name: "app",
            data: "192.0.2.20",
            ttl: 600,
          }),
        ),
      );
      expect(updated.recordId).toEqual(created.recordId);
      const remote = yield* readRecord(domain, created.recordId);
      expect(remote).toMatchObject({ name: "app", data: "192.0.2.20", ttl: 600 });

      const replaced = yield* stack.deploy(
        withDomain(domain, (zone) =>
          DigitalOcean.DomainRecord("Www", {
            domain: zone,
            type: "TXT",
            name: "app",
            data: "hello",
          }),
        ),
      );
      expect(replaced.recordId).not.toEqual(created.recordId);
      expect(yield* isGone(readRecord(domain, created.recordId))).toBe(true);

      yield* stack.destroy();

      expect(yield* isGone(readRecord(domain, replaced.recordId))).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider(
  "MX, SRV and CAA records carry their type-specific fields",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const domain = testDomain(stack.stage, "records-typed");

      const deployed = yield* stack.deploy(
        withDomain(domain, (zone) =>
          Effect.all({
            mx: DigitalOcean.DomainRecord("Mx", {
              domain: zone,
              type: "MX",
              name: "@",
              data: "mail.example.com.",
              priority: 10,
            }),
            srv: DigitalOcean.DomainRecord("Srv", {
              domain: zone,
              type: "SRV",
              name: "_sip._tcp",
              data: "sip.example.com.",
              priority: 10,
              weight: 5,
              port: 5060,
            }),
            caa: DigitalOcean.DomainRecord("Caa", {
              domain: zone,
              type: "CAA",
              name: "@",
              data: "letsencrypt.org.",
              flags: 0,
              tag: "issue",
            }),
          }),
        ),
      );
      expect(yield* readRecord(domain, deployed.mx.recordId)).toMatchObject({ priority: 10 });
      expect(yield* readRecord(domain, deployed.srv.recordId)).toMatchObject({
        priority: 10,
        weight: 5,
        port: 5060,
      });
      expect(yield* readRecord(domain, deployed.caa.recordId)).toMatchObject({
        flags: 0,
        tag: "issue",
      });

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider(
  "a record whose attributes were lost is found by its name, type and value",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const domain = testDomain(stack.stage, "records-lost");
      const declared = withDomain(domain, (zone) =>
        DigitalOcean.DomainRecord("Txt", {
          domain: zone,
          type: "TXT",
          name: "lost",
          data: "found",
        }),
      );

      const created = yield* stack.deploy(declared);
      yield* forgetAttributes({ stack: stack.name, stage: stack.stage, fqn: "Txt" });

      const resumed = yield* stack.deploy(declared);
      expect(resumed.recordId).toEqual(created.recordId);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
