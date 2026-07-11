import * as AWS from "@/AWS";
import { EventDataStore } from "@/AWS/CloudTrail";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import * as Test from "@/Test/Vitest";
import * as cloudtrail from "@distilled.cloud/aws/cloudtrail";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: a well-formed ARN pointing at a nonexistent
// store must surface the typed not-found the provider's read/delete paths
// depend on.
test.provider(
  "getEventDataStore on a nonexistent store fails with EventDataStoreNotFoundException",
  () =>
    Effect.gen(function* () {
      const { accountId, region } = yield* AWSEnvironment.current;
      const error = yield* Effect.flip(
        cloudtrail.getEventDataStore({
          EventDataStore: `arn:aws:cloudtrail:${region}:${accountId}:eventdatastore/00000000-0000-0000-0000-000000000000`,
        }),
      );
      expect(error._tag).toBe("EventDataStoreNotFoundException");
    }),
);

// Ungated entitlement probe: CloudTrail Lake stopped accepting NEW
// customers (InvalidParameterException "CloudTrail Lake is no longer
// accepting new customers..."), which the distilled patch surfaces as the
// typed `CloudTrailLakeOnboardingClosed` tag. On a non-onboarded account
// this proves the patch; on an onboarded account the create succeeds and
// is immediately deleted (PENDING_DELETION incurs no cost).
test.provider(
  "createEventDataStore is either typed onboarding-closed or a real create",
  () =>
    Effect.gen(function* () {
      const attempt = yield* Effect.result(
        cloudtrail.createEventDataStore({
          Name: "alchemy-test-cloudtrail-lake-probe",
          MultiRegionEnabled: false,
          RetentionPeriod: 7,
          TerminationProtectionEnabled: false,
        }),
      );
      if (Result.isSuccess(attempt)) {
        // Onboarded account — clean up immediately.
        yield* cloudtrail
          .deleteEventDataStore({
            EventDataStore: attempt.success.EventDataStoreArn!,
          })
          .pipe(
            Effect.catchTag(
              [
                "EventDataStoreNotFoundException",
                "InactiveEventDataStoreException",
              ],
              () => Effect.void,
            ),
          );
        return;
      }
      expect([
        "CloudTrailLakeOnboardingClosed",
        // A prior probe's store still pending deletion holds the name on
        // an onboarded account.
        "EventDataStoreAlreadyExistsException",
      ]).toContain(attempt.failure._tag);
    }),
);

const STORE_NAME = "alchemy-test-cloudtrail-eds";

// A deleted store sits in PENDING_DELETION for 7 days (no cost) and keeps
// its name; the provider restores such a store instead of creating a
// duplicate, which is what makes this test re-runnable day after day.
//
// GATED: CloudTrail Lake is closed to new customers (see the ungated probe
// above) — the full lifecycle only runs on an account that was onboarded
// to Lake before the closure. Set AWS_TEST_CLOUDTRAIL_LAKE=1 to run it.
test.provider.skipIf(!process.env.AWS_TEST_CLOUDTRAIL_LAKE)(
  "create event data store, update retention, delete (PENDING_DELETION)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const make = (props: {
        retentionPeriod: number;
        tags?: Record<string, string>;
      }) =>
        Effect.gen(function* () {
          const store = yield* EventDataStore("Lake", {
            name: STORE_NAME,
            multiRegionEnabled: false,
            retentionPeriod: props.retentionPeriod,
            terminationProtectionEnabled: false,
            tags: props.tags,
          });
          return { store };
        });

      // 1. Create with the 7-day minimum retention.
      const { store } = yield* stack.deploy(
        make({ retentionPeriod: 7, tags: { fixture: "cloudtrail-eds" } }),
      );
      expect(store.name).toBe(STORE_NAME);
      expect(store.eventDataStoreArn).toContain(":eventdatastore/");
      expect(["CREATED", "ENABLED", "STARTING_INGESTION"]).toContain(
        store.status,
      );

      // Out-of-band verification via distilled.
      const observed = yield* cloudtrail.getEventDataStore({
        EventDataStore: store.eventDataStoreArn,
      });
      expect(observed.Name).toBe(STORE_NAME);
      expect(observed.RetentionPeriod).toBe(7);
      expect(observed.TerminationProtectionEnabled).toBe(false);
      expect(observed.MultiRegionEnabled).toBe(false);
      const tags = yield* cloudtrail.listTags({
        ResourceIdList: [store.eventDataStoreArn],
      });
      const tagRecord = Object.fromEntries(
        (tags.ResourceTagList?.[0]?.TagsList ?? []).map((t) => [
          t.Key,
          t.Value,
        ]),
      );
      expect(tagRecord.fixture).toBe("cloudtrail-eds");
      expect(tagRecord["alchemy::id"]).toBe("Lake");

      // 2. Update retention in place — the ARN is the stable identity.
      const { store: updated } = yield* stack.deploy(
        make({ retentionPeriod: 14, tags: { team: "audit" } }),
      );
      expect(updated.eventDataStoreArn).toBe(store.eventDataStoreArn);
      const observedAfter = yield* cloudtrail.getEventDataStore({
        EventDataStore: store.eventDataStoreArn,
      });
      expect(observedAfter.RetentionPeriod).toBe(14);
      const tagsAfter = yield* cloudtrail.listTags({
        ResourceIdList: [store.eventDataStoreArn],
      });
      const tagRecordAfter = Object.fromEntries(
        (tagsAfter.ResourceTagList?.[0]?.TagsList ?? []).map((t) => [
          t.Key,
          t.Value,
        ]),
      );
      expect(tagRecordAfter.team).toBe("audit");
      expect(tagRecordAfter.fixture).toBeUndefined();

      // 3. Delete — schedules PENDING_DELETION (7-day wait, zero cost);
      // do NOT wait for the store to disappear.
      yield* stack.destroy();
      const afterDelete = yield* cloudtrail
        .getEventDataStore({ EventDataStore: store.eventDataStoreArn })
        .pipe(
          Effect.map((r) => r.Status ?? "UNKNOWN"),
          Effect.catchTag("EventDataStoreNotFoundException", () =>
            Effect.succeed("GONE" as const),
          ),
        );
      expect(["PENDING_DELETION", "GONE"]).toContain(afterDelete);
    }),
  { timeout: 180_000 },
);
