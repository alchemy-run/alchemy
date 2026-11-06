import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as dns from "@distilled.cloud/cloudflare/dns";
import * as zones from "@distilled.cloud/cloudflare/zones";
import { adopt } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { expectDeployFails } from "../../lookup.ts";
import { testName } from "../../names.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const tags = ["provider:cloudflare", "provider:cloudflare:zone", "live"];

// The standing test zone: it exists in the testing account and no test stack
// owns it (zones retain on removal), which is exactly what a lookup targets.
const zoneName = process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";
const recordName = `${testName("alchemy-zone-lookup")}.${zoneName}`;

const recordsNamed = (zoneId: string, name: string) =>
  dns.listRecords.items({ zoneId, name: { exact: name }, type: "TXT" }).pipe(
    Stream.filter((r) => r.name === name),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

test.provider(
  "a looked-up zone hosts a DNS record, by name and by id",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const standing = yield* findZoneByName({ accountId, name: zoneName });
      expect(standing).toBeDefined();
      const zoneId = standing!.id;

      const program = Effect.gen(function* () {
        const byName = Cloudflare.Zone.Zone.lookup({ name: zoneName });
        const byId = Cloudflare.Zone.Zone.lookup({ zoneId });
        yield* Cloudflare.DNS.Record("zone-lookup-record", {
          zoneId: byName.zoneId,
          name: recordName,
          type: "TXT",
          content: '"looked-up zone"',
        });
        return { zoneId: byName.zoneId, nameById: byId.name };
      });
      const out = yield* stack.deploy(program);
      expect(out.zoneId).toBe(zoneId);
      expect(out.nameById).toBe(zoneName);

      const records = yield* recordsNamed(zoneId, recordName);
      expect(records.map((r) => r.content)).toEqual(['"looked-up zone"']);

      // A lookup re-resolves to the same zone, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["zone-lookup-record"].action).toBe("noop");

      // Destroy removes the record and leaves the zone alone.
      yield* stack.destroy();
      expect(yield* recordsNamed(zoneId, recordName)).toEqual([]);
      const survivor = yield* zones.getZone({ zoneId });
      expect(survivor.name).toBe(zoneName);
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "a lookup of a missing zone fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = `${testName("missing-zone")}.invalid`;
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.DNS.Record("zone-lookup-missing", {
            zoneId: Cloudflare.Zone.Zone.lookup({ name }).zoneId,
            name: `missing.${name}`,
            type: "TXT",
            content: '"never"',
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a zone this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      // Zones retain on removal, so adopting the standing zone and
      // destroying the stack leaves it in place.
      const managed = () =>
        Cloudflare.Zone.Zone("zone-lookup-managed", { name: zoneName }).pipe(adopt(true));
      yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.DNS.Record("zone-lookup-managed-record", {
              zoneId: Cloudflare.Zone.Zone.lookup({ name: zoneName }).zoneId,
              name: recordName,
              type: "TXT",
              content: '"never"',
            });
          }),
        ),
        ["LookupOfManagedResourceError", "zone-lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
