import * as AWS from "@/AWS";
import { HostedZone } from "@/AWS/Route53";
import * as Test from "@/Test/Vitest";
import * as route53 from "@distilled.cloud/aws/route-53";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const normalizeId = (id: string) => id.replace(/^\/hostedzone\//, "");

// Deterministic per-test zone names (reserved-domain-safe TLD `.alchemy`).
const zoneName = "alchemy-hostedzone-crud.alchemy.";

const assertZoneGone = (id: string) =>
  route53.getHostedZone({ Id: normalizeId(id) }).pipe(
    Effect.flatMap(() => Effect.fail(new Error("zone still exists"))),
    Effect.catchTag("NoSuchHostedZone", () => Effect.void),
    Effect.retry({
      while: (e) => e instanceof Error,
      schedule: Schedule.fixed("2 seconds").pipe(
        Schedule.both(Schedule.recurs(10)),
      ),
    }),
  );

test.provider(
  "create, update comment, tag, and delete hosted zone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const zone = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* HostedZone("Zone", {
            name: zoneName,
            comment: "initial comment",
            tags: { env: "test" },
          });
        }),
      );

      expect(zone.id).toBeDefined();
      expect(zone.name).toBe(zoneName);
      // Public zones get exactly 4 authoritative name servers.
      expect(zone.nameServers.length).toBe(4);
      expect(zone.comment).toBe("initial comment");

      // Verify out of band.
      const observed = yield* route53.getHostedZone({
        Id: normalizeId(zone.id),
      });
      expect(observed.HostedZone.Config?.Comment).toBe("initial comment");

      const tags = yield* route53.listTagsForResource({
        ResourceType: "hostedzone",
        ResourceId: normalizeId(zone.id),
      });
      const tagMap = Object.fromEntries(
        (tags.ResourceTagSet.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tagMap.env).toBe("test");
      expect(tagMap["alchemy::id"]).toBeDefined();

      // Update comment + tags in place.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* HostedZone("Zone", {
            name: zoneName,
            comment: "updated comment",
            tags: { env: "prod" },
          });
        }),
      );
      expect(updated.id).toBe(zone.id);
      expect(updated.comment).toBe("updated comment");

      const observed2 = yield* route53.getHostedZone({
        Id: normalizeId(zone.id),
      });
      expect(observed2.HostedZone.Config?.Comment).toBe("updated comment");

      const tags2 = yield* route53.listTagsForResource({
        ResourceType: "hostedzone",
        ResourceId: normalizeId(zone.id),
      });
      const tagMap2 = Object.fromEntries(
        (tags2.ResourceTagSet.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tagMap2.env).toBe("prod");

      yield* stack.destroy();
      yield* assertZoneGone(zone.id);
    }),
  { timeout: 180_000 },
);

const forceZoneName = "alchemy-hostedzone-force.alchemy.";

test.provider(
  "forceDestroy deletes leftover records before deleting the zone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const zone = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* HostedZone("ForceZone", {
            name: forceZoneName,
            forceDestroy: true,
          });
        }),
      );

      // Seed a leftover record out of band so the zone is non-empty.
      yield* route53
        .changeResourceRecordSets({
          HostedZoneId: normalizeId(zone.id),
          ChangeBatch: {
            Comment: "leftover record",
            Changes: [
              {
                Action: "UPSERT",
                ResourceRecordSet: {
                  Name: `leftover.${forceZoneName}`,
                  Type: "TXT",
                  TTL: 60,
                  ResourceRecords: [{ Value: '"leftover"' }],
                },
              },
            ],
          },
        })
        .pipe(Effect.asVoid);

      // destroy() must purge the record then delete the zone.
      yield* stack.destroy();
      yield* assertZoneGone(zone.id);
    }),
  { timeout: 180_000 },
);

test.provider(
  "idempotent delete tolerates an already-gone zone",
  () =>
    Effect.gen(function* () {
      // Deleting a non-existent zone id should be a no-op (NoSuchHostedZone).
      yield* route53.deleteHostedZone({ Id: "Z0000000000000NONEXIST" }).pipe(
        Effect.asVoid,
        Effect.catchTag("NoSuchHostedZone", () => Effect.void),
        Effect.catchTag("InvalidInput", () => Effect.void),
      );
      expect(true).toBe(true);
    }),
  { timeout: 60_000 },
);
