import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as dns from "@distilled.cloud/cloudflare/dns";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { noopSession } from "alchemy/Report";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { testName } from "../../names.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const zoneName = process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Deterministic per-test record names. Each test owns a disjoint subdomain so
// reruns and parallel runs never collide, and the same name is reused on every
// run (never derive physical names from Date.now()/random).
const NAME_DEFAULT = `${testName("alchemy-dnsrecord-default")}.${zoneName}`;
const NAME_UPDATE = `${testName("alchemy-dnsrecord-update")}.${zoneName}`;
const NAME_REPLACE = `${testName("alchemy-dnsrecord-replace")}.${zoneName}`;
const NAME_RENAMED = `${testName("alchemy-dnsrecord-renamed")}.${zoneName}`;
const NAME_SIBLING = `${testName("alchemy-dnsrecord-sibling")}.${zoneName}`;
const NAME_ADOPT = `${testName("alchemy-dnsrecord-adopt")}.${zoneName}`;
const NAME_ADOPT_RELATIVE = testName("alchemy-dnsrecord-relative-adopt");
const NAME_ADOPT_RELATIVE_FQDN = `${NAME_ADOPT_RELATIVE}.${zoneName}`;
const NAME_LIST = `${testName("alchemy-dnsrecord-list")}.${zoneName}`;
const NAME_MX = `${testName("alchemy-dnsrecord-mx")}.${zoneName}`;
const NAME_MX_PRIORITY = `${testName("alchemy-dnsrecord-mx-priority")}.${zoneName}`;
const NAME_SVCB = `_alchemy-dnsrecord._tcp.${zoneName}`;
const NAME_SVCB_ADOPT = `_alchemy-dnsrecord-adopt._tcp.${zoneName}`;
const NAME_HTTPS = `${testName("alchemy-dnsrecord-https")}.${zoneName}`;
const NAME_CNAME_ADOPT = `${testName("alchemy-dnsrecord-cname-adopt")}.${zoneName}`;

const SVCB_DATA_V1 = {
  priority: 1,
  target: `${testName("svc")}.${zoneName}.`,
  value: 'alpn="h2" port="443"',
} satisfies Cloudflare.DNS.RecordData;

const SVCB_DATA_V2 = {
  priority: 1,
  target: `${testName("svc")}.${zoneName}.`,
  value: 'mandatory="alpn,port" alpn="h2,h3" port="8443"',
} satisfies Cloudflare.DNS.RecordData;
const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(new Error(`zone "${zoneName}" not found in account`));
  }
  return zone.id;
});

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — a fresh token intermittently 403s
// with "Unable to authenticate request". Ride out the blips on the test's
// own out-of-band verification calls by retrying the typed `Forbidden` error
// (part of each dns operation's error union via distilled patches).
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

// Server-side `(name, type)` filter (deepObject `name.exact=…`, needs
// distilled >= 0.24.9) plus a client-side match as defense in depth.
const listByNameType = (zoneId: string, name: string, type: string) =>
  dns.listRecords
    .items({ zoneId, name: { exact: name }, type: type as dns.ListRecordsRequest["type"] })
    .pipe(
      Stream.filter((r) => r.name === name && r.type === type),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.retry({
        while: (e) => e._tag === "Forbidden",
        schedule: forbiddenRetrySchedule,
        times: 8,
      }),
    );

const findRecord = (zoneId: string, name: string, type: string) =>
  listByNameType(zoneId, name, type).pipe(Effect.map((rs) => rs[0]));

const getRecord = (zoneId: string, dnsRecordId: string) =>
  dns.getRecord({ zoneId, dnsRecordId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Delete every record matching (name, type) — used to purge leftovers from
// interrupted runs so the adoption test starts from a clean slate.
const purgeRecords = (zoneId: string, name: string, type: string) =>
  listByNameType(zoneId, name, type).pipe(
    Effect.flatMap(
      Effect.forEach((r) =>
        dns.deleteRecord({ zoneId, dnsRecordId: r.id }).pipe(Effect.catch(() => Effect.void)),
      ),
    ),
  );

test.provider(
  "create and delete an A record with default props",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      const record = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.DNS.Record("DefaultA", {
            zoneId,
            name: NAME_DEFAULT,
            type: "A",
            content: "203.0.113.10",
          }).pipe(adopt(true));
        }),
      );

      expect(record.recordId).toBeDefined();
      expect(record.zoneId).toEqual(zoneId);
      expect(record.name).toEqual(NAME_DEFAULT);
      expect(record.type).toEqual("A");
      expect(record.content).toEqual("203.0.113.10");
      // Cloudflare echoes ttl=1 for "automatic" (the default).
      expect(record.ttl).toEqual(1);
      expect(record.proxied).toEqual(false);

      const live = yield* getRecord(zoneId, record.recordId);
      expect(live.id).toEqual(record.recordId);
      expect(live.name).toEqual(NAME_DEFAULT);
      expect(live.type).toEqual("A");
      expect(live.content).toEqual("203.0.113.10");
      expect(live.comment).toEqual("Managed by Alchemy (DefaultA)");

      yield* stack.destroy();

      const gone = yield* findRecord(zoneId, NAME_DEFAULT, "A");
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:dns", "provider:cloudflare:zone", "live"] },
);

test.provider(
  "creates, lists, and updates an SVCB record from structured data",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeRecords(zoneId, NAME_SVCB, "SVCB");

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.DNS.Record("StructuredSvcb", {
            zoneId,
            name: NAME_SVCB,
            type: "SVCB",
            content: SVCB_DATA_V1,
          }).pipe(adopt(true));
        }),
      );

      expect(initial.type).toEqual("SVCB");
      expect(typeof initial.content).toEqual("string");
      expect(initial.data).toEqual(SVCB_DATA_V1);

      const created = yield* getRecord(zoneId, initial.recordId);
      expect(created.type).toEqual("SVCB");
      expect("data" in created ? created.data : undefined).toEqual(SVCB_DATA_V1);

      const provider = yield* Provider.findProvider(Cloudflare.DNS.Record);
      const listed = (yield* provider.list()).find(
        (record) => record.recordId === initial.recordId,
      );
      expect(listed?.data).toEqual(SVCB_DATA_V1);

      // Introduce drift out of band, then change the desired data. Reconcile
      // must compare against the observed components and patch in place.
      yield* dns.updateRecord({
        zoneId,
        dnsRecordId: initial.recordId,
        name: NAME_SVCB,
        type: "SVCB",
        ttl: 1,
        data: { ...SVCB_DATA_V1, value: 'alpn="h3" port="9443"' },
      });

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.DNS.Record("StructuredSvcb", {
            zoneId,
            name: NAME_SVCB,
            type: "SVCB",
            content: SVCB_DATA_V2,
          }).pipe(adopt(true));
        }),
      );

      expect(updated.recordId).toEqual(initial.recordId);
      expect(updated.data).toEqual(SVCB_DATA_V2);

      const live = yield* getRecord(zoneId, updated.recordId);
      expect("data" in live ? live.data : undefined).toEqual(SVCB_DATA_V2);

      yield* stack.destroy();

      const gone = yield* findRecord(zoneId, NAME_SVCB, "SVCB");
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:dns", "provider:cloudflare:zone", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "creates and deletes an HTTPS record from structured data",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;
      const data = {
        priority: 1,
        target: ".",
        value: 'alpn="h2,h3"',
      } satisfies Cloudflare.DNS.RecordData;

      yield* stack.destroy();
      yield* purgeRecords(zoneId, NAME_HTTPS, "HTTPS");

      const record = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.DNS.Record("StructuredHttps", {
            zoneId,
            name: NAME_HTTPS,
            type: "HTTPS",
            content: data,
          }).pipe(adopt(true));
        }),
      );

      expect(record.type).toEqual("HTTPS");
      expect(record.data).toEqual(data);

      const live = yield* getRecord(zoneId, record.recordId);
      expect(live.type).toEqual("HTTPS");
      expect("data" in live ? live.data : undefined).toEqual(data);

      yield* stack.destroy();

      const gone = yield* findRecord(zoneId, NAME_HTTPS, "HTTPS");
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:dns", "provider:cloudflare:zone", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "updating mutable fields patches in place",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.DNS.Record("UpdateA", {
            zoneId,
            name: NAME_UPDATE,
            type: "A",
            content: "203.0.113.20",
            ttl: 300,
            comment: "v1",
          }).pipe(adopt(true));
        }),
      );

      expect(initial.content).toEqual("203.0.113.20");
      expect(initial.ttl).toEqual(300);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.DNS.Record("UpdateA", {
            zoneId,
            name: NAME_UPDATE,
            type: "A",
            content: "203.0.113.21",
            ttl: 600,
            comment: "v2",
          }).pipe(adopt(true));
        }),
      );

      // Same record patched in place — not a replacement.
      expect(updated.recordId).toEqual(initial.recordId);
      expect(updated.content).toEqual("203.0.113.21");
      expect(updated.ttl).toEqual(600);

      const live = yield* getRecord(zoneId, updated.recordId);
      expect(live.content).toEqual("203.0.113.21");
      expect(live.ttl).toEqual(600);
      expect(live.comment).toEqual("v2");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:dns", "provider:cloudflare:zone", "live"] },
);

test.provider(
  "changing the name and type updates the record in place",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.DNS.Record("ReplaceRecord", {
            zoneId,
            name: NAME_REPLACE,
            type: "A",
            content: "203.0.113.30",
          });
        }),
      );

      expect(initial.type).toEqual("A");

      const changed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.DNS.Record("ReplaceRecord", {
            zoneId,
            name: NAME_RENAMED,
            type: "TXT",
            content: '"alchemy-replace-test"',
          });
        }),
      );

      // The Cloudflare record id is the record's identity.
      expect(changed.recordId).toEqual(initial.recordId);
      expect(changed.name).toEqual(NAME_RENAMED);
      expect(changed.type).toEqual("TXT");

      const live = yield* getRecord(zoneId, initial.recordId);
      expect(live.name).toEqual(NAME_RENAMED);
      expect(live.type).toEqual("TXT");
      expect(yield* findRecord(zoneId, NAME_REPLACE, "A")).toBeUndefined();

      yield* stack.destroy();

      expect(yield* findRecord(zoneId, NAME_RENAMED, "TXT")).toBeUndefined();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:dns", "provider:cloudflare:zone", "live"] },
);

// #2943: a lone record with different content at the same name is a
// sibling, not this record, so it's neither adopted nor overwritten.
test.provider(
  "a second record at a name is created beside the existing one",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeRecords(zoneId, NAME_SIBLING, "TXT");

      const verification = Effect.gen(function* () {
        return yield* Cloudflare.DNS.Record("Verification", {
          zoneId,
          name: NAME_SIBLING,
          type: "TXT",
          content: '"google-site-verification=abc"',
        });
      });
      const first = yield* stack.deploy(verification);

      const both = yield* stack.deploy(
        Effect.gen(function* () {
          return {
            verification: yield* verification,
            spf: yield* Cloudflare.DNS.Record("Spf", {
              zoneId,
              name: NAME_SIBLING,
              type: "TXT",
              content: '"v=spf1 include:_spf.google.com ~all"',
            }),
          };
        }),
      );

      expect(both.verification.recordId).toEqual(first.recordId);
      expect(both.spf.recordId).not.toEqual(first.recordId);
      const live = yield* listByNameType(zoneId, NAME_SIBLING, "TXT");
      expect(live.map((r) => r.content).sort()).toEqual([
        '"google-site-verification=abc"',
        '"v=spf1 include:_spf.google.com ~all"',
      ]);

      yield* stack.destroy();

      expect(yield* listByNameType(zoneId, NAME_SIBLING, "TXT")).toEqual([]);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:dns", "provider:cloudflare:zone", "live"] },
);

test.provider(
  "adoption — a matching record errors without adopt, is taken over with adopt(true)",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      // Purge leftovers from interrupted runs (Cloudflare allows duplicate
      // A records for the same name, so a leaked record would not surface
      // as a create conflict).
      yield* purgeRecords(zoneId, NAME_ADOPT, "A");

      // Create the record out-of-band so the stack has no state of its own
      // for it — exactly the "the record already exists" scenario.
      const pre = yield* dns
        .createRecord({
          zoneId,
          name: NAME_ADOPT,
          type: "A",
          content: "203.0.113.40",
          ttl: 1,
          comment: "pre-existing",
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
        );
      expect(pre.id).toBeDefined();

      // A record with different content is a sibling, not this record:
      // nothing to adopt, so a new record is created beside it.
      const sibling = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.DNS.Record("AdoptedRecord", {
            zoneId,
            name: NAME_ADOPT,
            type: "A",
            content: "203.0.113.41",
          });
        }),
      );
      expect(sibling.recordId).not.toEqual(pre.id);
      yield* stack.destroy();
      expect((yield* getRecord(zoneId, pre.id!)).content).toEqual("203.0.113.40");

      // Without `adopt`: DNS records carry no ownership markers, so the
      // engine cannot prove we created it and refuses to take it over.
      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.DNS.Record("AdoptedRecord", {
              zoneId,
              name: NAME_ADOPT,
              type: "A",
              content: "203.0.113.40",
            });
          }),
        )
        .pipe(
          Effect.as(undefined),
          Effect.catchCause((cause) => Effect.succeed(findOwnedError(cause))),
        );
      expect(error).toBeInstanceOf(OwnedBySomeoneElse);

      // With `adopt(true)`: the engine takes over the pre-existing record
      // (same physical id) and stamps it with the default comment.
      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.DNS.Record("AdoptedRecord", {
            zoneId,
            name: NAME_ADOPT,
            type: "A",
            content: "203.0.113.40",
          }).pipe(adopt(true));
        }),
      );
      expect(adopted.recordId).toEqual(pre.id);
      expect((yield* getRecord(zoneId, pre.id!)).comment).toEqual(
        "Managed by Alchemy (AdoptedRecord)",
      );

      // Once adopted, the record is tracked by its id and its content
      // updates in place.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.DNS.Record("AdoptedRecord", {
            zoneId,
            name: NAME_ADOPT,
            type: "A",
            content: "203.0.113.41",
          });
        }),
      );

      expect(updated.recordId).toEqual(pre.id);
      expect(updated.content).toEqual("203.0.113.41");

      const live = yield* getRecord(zoneId, updated.recordId);
      expect(live.content).toEqual("203.0.113.41");

      yield* stack.destroy();

      const gone = yield* findRecord(zoneId, NAME_ADOPT, "A");
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:dns", "provider:cloudflare:zone", "live"] },
);

// A CNAME is exclusive at its name, so the one there is this record
// whatever it points at.
test.provider(
  "adoption takes over a CNAME that points elsewhere",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeRecords(zoneId, NAME_CNAME_ADOPT, "CNAME");

      const pre = yield* dns.createRecord({
        zoneId,
        name: NAME_CNAME_ADOPT,
        type: "CNAME",
        content: `old.${zoneName}`,
        ttl: 1,
      });

      const cname = Cloudflare.DNS.Record("AdoptedCname", {
        zoneId,
        name: NAME_CNAME_ADOPT,
        type: "CNAME",
        content: `new.${zoneName}`,
      });

      const error = yield* stack.deploy(cname).pipe(
        Effect.as(undefined),
        Effect.catchCause((cause) => Effect.succeed(findOwnedError(cause))),
      );
      expect(error).toBeInstanceOf(OwnedBySomeoneElse);

      const adopted = yield* stack.deploy(cname.pipe(adopt(true)));
      expect(adopted.recordId).toEqual(pre.id);
      expect(adopted.content).toEqual(`new.${zoneName}`);
      expect((yield* getRecord(zoneId, pre.id!)).content).toEqual(`new.${zoneName}`);

      yield* stack.destroy();

      expect(yield* findRecord(zoneId, NAME_CNAME_ADOPT, "CNAME")).toBeUndefined();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:dns", "provider:cloudflare:zone", "live"] },
);

test.provider(
  "adoption converges an existing structured SVCB record",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeRecords(zoneId, NAME_SVCB_ADOPT, "SVCB");

      const pre = yield* dns.createRecord({
        zoneId,
        name: NAME_SVCB_ADOPT,
        type: "SVCB",
        ttl: 1,
        data: SVCB_DATA_V1,
      });

      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.DNS.Record("AdoptedStructuredSvcb", {
              zoneId,
              name: NAME_SVCB_ADOPT,
              type: "SVCB",
              content: SVCB_DATA_V1,
            });
          }),
        )
        .pipe(
          Effect.as(undefined),
          Effect.catchCause((cause) => Effect.succeed(findOwnedError(cause))),
        );
      expect(error).toBeInstanceOf(OwnedBySomeoneElse);

      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.DNS.Record("AdoptedStructuredSvcb", {
            zoneId,
            name: NAME_SVCB_ADOPT,
            type: "SVCB",
            content: SVCB_DATA_V1,
          }).pipe(adopt(true));
        }),
      );
      expect(adopted.recordId).toEqual(pre.id);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.DNS.Record("AdoptedStructuredSvcb", {
            zoneId,
            name: NAME_SVCB_ADOPT,
            type: "SVCB",
            content: SVCB_DATA_V2,
          });
        }),
      );

      expect(updated.recordId).toEqual(pre.id);
      expect(updated.data).toEqual(SVCB_DATA_V2);

      const live = yield* getRecord(zoneId, updated.recordId);
      expect("data" in live ? live.data : undefined).toEqual(SVCB_DATA_V2);

      yield* stack.destroy();

      const gone = yield* findRecord(zoneId, NAME_SVCB_ADOPT, "SVCB");
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:dns", "provider:cloudflare:zone", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "adoption finds a normalized FQDN when given a relative record name",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeRecords(zoneId, NAME_ADOPT_RELATIVE_FQDN, "TXT");

      const pre = yield* dns.createRecord({
        zoneId,
        name: NAME_ADOPT_RELATIVE_FQDN,
        type: "TXT",
        content: "pre-existing",
        ttl: 1,
      });

      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.DNS.Record("RelativeAdoptedRecord", {
            zoneId,
            name: NAME_ADOPT_RELATIVE,
            type: "TXT",
            content: "pre-existing",
          }).pipe(adopt(true));
        }),
      );

      expect(adopted.recordId).toEqual(pre.id);
      expect(adopted.name).toEqual(NAME_ADOPT_RELATIVE_FQDN);
      expect(adopted.content).toEqual("pre-existing");

      yield* stack.destroy();

      const gone = yield* findRecord(zoneId, NAME_ADOPT_RELATIVE_FQDN, "TXT");
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:dns", "provider:cloudflare:zone", "live"] },
);

// Several records legitimately share `(name, type)` — e.g. a primary MX and
// its fallback. Adoption must select the record whose `content`/`priority`
// match the declaration exactly, never "the first match" (#1262).
test.provider(
  "adoption disambiguates records sharing (name, type) by content/priority",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeRecords(zoneId, NAME_MX, "MX");

      // Two pre-existing MX records for the same name — only content and
      // priority tell them apart.
      const prePrimary = yield* dns
        .createRecord({
          zoneId,
          name: NAME_MX,
          type: "MX",
          content: `${testName("mx1")}.${zoneName}`,
          priority: 1,
          ttl: 1,
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
        );
      const preBackup = yield* dns.createRecord({
        zoneId,
        name: NAME_MX,
        type: "MX",
        content: `${testName("mx2")}.${zoneName}`,
        priority: 10,
        ttl: 1,
      });

      const { primary, backup } = yield* stack.deploy(
        Effect.gen(function* () {
          const primary = yield* Cloudflare.DNS.Record("PrimaryMx", {
            zoneId,
            name: NAME_MX,
            type: "MX",
            content: `${testName("mx1")}.${zoneName}`,
            priority: 1,
          }).pipe(adopt(true));
          const backup = yield* Cloudflare.DNS.Record("BackupMx", {
            zoneId,
            name: NAME_MX,
            type: "MX",
            content: `${testName("mx2")}.${zoneName}`,
            priority: 10,
          }).pipe(adopt(true));
          return { primary, backup };
        }),
      );

      // Each logical resource adopted its own physical record.
      expect(primary.recordId).toEqual(prePrimary.id);
      expect(backup.recordId).toEqual(preBackup.id);
      expect(primary.recordId).not.toEqual(backup.recordId);

      // Adopt-then-modify: change the backup's priority; same physical id.
      const changed = yield* stack.deploy(
        Effect.gen(function* () {
          const primary = yield* Cloudflare.DNS.Record("PrimaryMx", {
            zoneId,
            name: NAME_MX,
            type: "MX",
            content: `${testName("mx1")}.${zoneName}`,
            priority: 1,
          }).pipe(adopt(true));
          const backup = yield* Cloudflare.DNS.Record("BackupMx", {
            zoneId,
            name: NAME_MX,
            type: "MX",
            content: `${testName("mx2")}.${zoneName}`,
            priority: 20,
          }).pipe(adopt(true));
          return { primary, backup };
        }),
      );
      expect(changed.backup.recordId).toEqual(preBackup.id);
      const liveBackup = yield* getRecord(zoneId, changed.backup.recordId);
      expect("priority" in liveBackup ? liveBackup.priority : undefined).toEqual(20);
      const livePrimary = yield* getRecord(zoneId, changed.primary.recordId);
      expect("priority" in livePrimary ? livePrimary.priority : undefined).toEqual(1);

      yield* stack.destroy();

      const leftovers = yield* listByNameType(zoneId, NAME_MX, "MX");
      expect(leftovers).toEqual([]);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:dns", "provider:cloudflare:zone", "live"] },
);

// Priority is part of an MX record's identity: the same host at another
// priority is a sibling, not this record.
test.provider(
  "an MX record with the same host at another priority is not adopted",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeRecords(zoneId, NAME_MX_PRIORITY, "MX");

      const host = `${testName("mx-priority")}.${zoneName}`;
      const pre = yield* dns.createRecord({
        zoneId,
        name: NAME_MX_PRIORITY,
        type: "MX",
        content: host,
        priority: 10,
        ttl: 1,
      });

      const record = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.DNS.Record("PriorityMx", {
            zoneId,
            name: NAME_MX_PRIORITY,
            type: "MX",
            content: host,
            priority: 20,
          });
        }),
      );

      expect(record.recordId).not.toEqual(pre.id);
      const preLive = yield* getRecord(zoneId, pre.id!);
      expect("priority" in preLive ? preLive.priority : undefined).toEqual(10);

      yield* stack.destroy();

      const leftovers = yield* listByNameType(zoneId, NAME_MX_PRIORITY, "MX");
      expect(leftovers.map((r) => r.id)).toEqual([pre.id]);
      yield* purgeRecords(zoneId, NAME_MX_PRIORITY, "MX");
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:dns", "provider:cloudflare:zone", "live"] },
);

// Canonical `list()` test (zone-scoped collection): `list()` enumerates every
// zone via `listAllZones`, exhaustively paginates each zone's DNS records, and
// hydrates them into the `read` Attributes shape. Deploy a record and assert it
// appears in the exhaustively-paginated result.
test.provider(
  "list enumerates the deployed DNS record",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      const record = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.DNS.Record("ListedA", {
            zoneId,
            name: NAME_LIST,
            type: "A",
            content: "203.0.113.50",
          }).pipe(adopt(true));
        }),
      );

      const provider = yield* Provider.findProvider(Cloudflare.DNS.Record);
      const all = yield* provider.list();

      expect(all.length).toBeGreaterThan(0);
      expect(all.some((r) => r.recordId === record.recordId)).toBe(true);
      const found = all.find((r) => r.recordId === record.recordId);
      expect(found?.zoneId).toEqual(zoneId);
      expect(found?.name).toEqual(NAME_LIST);
      expect(found?.type).toEqual("A");
      expect(found?.content).toEqual("203.0.113.50");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:dns", "provider:cloudflare:zone", "live"] },
);

/**
 * Pull the {@link OwnedBySomeoneElse} value out of a Cause regardless of
 * whether the engine raised it as a typed failure or a defect.
 */
const findOwnedError = (cause: Cause.Cause<unknown>): OwnedBySomeoneElse | undefined =>
  cause.reasons
    .map((reason) =>
      Cause.isFailReason(reason)
        ? reason.error
        : Cause.isDieReason(reason)
          ? reason.defect
          : undefined,
    )
    .find((value): value is OwnedBySomeoneElse => value instanceof OwnedBySomeoneElse);

test.provider(
  "missing DNS records recover on read and delete while other API errors propagate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const zoneId = yield* resolveZoneId;
      const name = `${testName("alchemy-dnsrecord-missing")}.${zoneName}`;
      const props = { zoneId, name, type: "A" as const, content: "192.0.2.1" };
      const record = yield* stack.deploy(
        Cloudflare.DNS.Record("MissingRecord", props).pipe(adopt(true)),
      );
      const provider = yield* Provider.findProvider(Cloudflare.DNS.Record);
      const input = {
        id: "MissingRecord",
        fqn: "MissingRecord",
        instanceId: "missing-record-test",
        olds: props,
        output: record,
        bindings: [],
        session: { ...noopSession, note: () => Effect.void },
      };

      // The real API must reject an inaccessible zone; neither lifecycle may
      // hide that failure as if the record had simply been deleted.
      const inaccessible = {
        ...input,
        output: { ...record, zoneId: "00000000000000000000000000000000" },
      };
      for (const operation of [provider.read!(inaccessible), provider.delete(inaccessible)]) {
        const result = yield* operation.pipe(Retry.none, Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) expect(result.failure._tag).not.toBe("RecordNotFound");
      }

      // Delete out of band to exercise stale persisted state against Cloudflare.
      yield* dns.deleteRecord({ zoneId, dnsRecordId: record.recordId });
      const missing = yield* dns
        .getRecord({ zoneId, dnsRecordId: record.recordId })
        .pipe(Effect.flip);
      expect(missing._tag).toBe("RecordNotFound");
      expect(yield* provider.read!(input)).toBeUndefined();
      yield* provider.delete(input);
      yield* provider.delete(input);
      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:dns", "provider:cloudflare:zone", "live"],
    timeout: 120000,
  },
);

// Type-level: Cloudflare rejects MX and URI records without a priority, so
// the props type requires one. Checked by the type-checker, never run.
export const _priorityIsRequired = (zoneId: string): Cloudflare.DNS.RecordProps[] => [
  // @ts-expect-error MX needs a priority
  { zoneId, name: "mx", type: "MX", content: "mail.example.com" },
  // @ts-expect-error URI needs a priority
  { zoneId, name: "uri", type: "URI", content: '10 1 "https://example.com"' },
  { zoneId, name: "mx", type: "MX", content: "mail.example.com", priority: 10 },
];
