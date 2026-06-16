import * as AWS from "@/AWS";
import { Record } from "@/AWS/Route53";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import * as route53 from "@distilled.cloud/aws/route-53";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

// Deterministic, reused across runs. Route53 keys a public-zone create on
// `CallerReference`, so re-running reuses the same zone rather than piling up
// duplicates. (`example.com` is reserved by AWS, hence the bespoke name.)
const zoneName = "alchemy-route53-list-test.com.";
const callerReference = "alchemy-route53-record-list-test";
const recordName = `list-record.${zoneName}`;
const recordValue = '"alchemy-list-test"';

const normalizeId = (id: string) => id.replace(/^\/hostedzone\//, "");

const findZoneIdByName = route53.listHostedZones.pages({}).pipe(
  Stream.runCollect,
  Effect.map((chunk) =>
    Array.from(chunk).flatMap((page) => page.HostedZones ?? []),
  ),
  Effect.map((zones) => zones.find((zone) => zone.Name === zoneName)?.Id),
);

const ensureZone = route53
  .createHostedZone({ Name: zoneName, CallerReference: callerReference })
  .pipe(
    Effect.map((response) => normalizeId(response.HostedZone.Id)),
    Effect.catchTag("HostedZoneAlreadyExists", () =>
      findZoneIdByName.pipe(
        Effect.flatMap((id) =>
          id !== undefined
            ? Effect.succeed(normalizeId(id))
            : Effect.die(
                new Error(
                  "hosted zone not found after HostedZoneAlreadyExists",
                ),
              ),
        ),
      ),
    ),
  );

// Create/delete the record set out of band. The Alchemy engine's own deploy
// path is currently blocked by a distilled schema bug (see the file footer),
// so we seed the record directly to exercise `list()` against real Route53.
const changeRecord = (hostedZoneId: string, action: "UPSERT" | "DELETE") =>
  route53
    .changeResourceRecordSets({
      HostedZoneId: hostedZoneId,
      ChangeBatch: {
        Comment: "Route53 Record list() test",
        Changes: [
          {
            Action: action,
            ResourceRecordSet: {
              Name: recordName,
              Type: "TXT",
              TTL: 60,
              ResourceRecords: [{ Value: recordValue }],
            },
          },
        ],
      },
    })
    .pipe(
      Effect.asVoid,
      Effect.catchTag("InvalidChangeBatch", () => Effect.void),
      Effect.catchTag("NoSuchHostedZone", () => Effect.void),
    );

const deleteZone = (hostedZoneId: string) =>
  route53.deleteHostedZone({ Id: hostedZoneId }).pipe(
    Effect.asVoid,
    // Best-effort teardown: tolerate a vanished or still-non-empty zone.
    Effect.catchTag("NoSuchHostedZone", () => Effect.void),
    Effect.catchTag("HostedZoneNotEmpty", () => Effect.void),
  );

test.provider(
  "list enumerates the deployed record across hosted zones",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const hostedZoneId = yield* ensureZone;
      yield* changeRecord(hostedZoneId, "UPSERT").pipe(
        Effect.tapError(() => deleteZone(hostedZoneId)),
      );

      const provider = yield* Provider.findProvider(Record);

      // `list()` fans out across every hosted zone; assert our seeded record
      // appears. Retry briefly to absorb Route53's create eventual consistency.
      const found = yield* provider.list().pipe(
        Effect.map((all) =>
          all.some(
            (r) =>
              normalizeId(r.hostedZoneId) === normalizeId(hostedZoneId) &&
              r.name === recordName &&
              r.type === "TXT",
          ),
        ),
        Effect.flatMap((present) =>
          present
            ? Effect.succeed(true)
            : Effect.fail(new Error("record not yet listable")),
        ),
        Effect.retry({
          schedule: Schedule.fixed("3 seconds").pipe(
            Schedule.both(Schedule.recurs(10)),
          ),
        }),
        Effect.catch(() => Effect.succeed(false)),
      );

      yield* changeRecord(hostedZoneId, "DELETE");
      yield* deleteZone(hostedZoneId);
      yield* stack.destroy();

      expect(found).toBe(true);
    }),
  { timeout: 240_000 },
);

// NOTE — distilled patch needed (do not apply here; reported to coordinator):
//   service: route-53
//   structures.ListResourceRecordSetsResponse.members.ResourceRecordSets.optional: true
//
// Route53 omits the `<ResourceRecordSets>` element entirely when a
// `ListResourceRecordSets` page is empty (e.g. when `StartRecordName` points
// past the last record — exactly what the provider's `read`/`findRecord`
// adoption probe does for a brand-new record). distilled currently marks the
// member required, so the response fails to parse with:
//   SchemaError: Missing key at ["ResourceRecordSets"]
// This blocks deploying any record through the Alchemy engine (the greenfield
// adoption probe in Plan.ts), so this test seeds the record out of band. Once
// the member is optional, `findRecord` should also coalesce
// `response.ResourceRecordSets ?? []`.
