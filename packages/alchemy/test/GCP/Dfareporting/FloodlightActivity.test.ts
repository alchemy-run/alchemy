import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dfa from "@distilled.cloud/gcp/dfareporting_v5";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  advertiserIdFromEnv,
  floodlightActivityGroupIdFromEnv,
  hasGcpCreds,
  logLevel,
  resolveProfileId,
  runFloodlightLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (profileId: string, id: string) =>
  dfa.getFloodlightActivities({ profileId, id }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getFloodlightActivities on a missing activity fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dfa.getFloodlightActivities({ profileId: "1", id: "1" }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_DFAREPORTING)(
  "insertFloodlightActivities without Campaign Manager access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dfa.insertFloodlightActivities({
          profileId: "1",
          body: {
            floodlightActivityGroupId: "1",
            name: "alchemy-dfareporting-probe",
            countingMethod: "STANDARD_COUNTING",
            floodlightTagType: "GLOBAL_SITE_TAG",
            conversionCategory: "CONVERSION_CATEGORY_PAGE_VIEW",
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runFloodlightLifecycle)(
  "create, update, and delete a floodlight activity",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const profileId = yield* resolveProfileId();
      expect(profileId).toEqual(expect.any(String));
      const advertiserId = advertiserIdFromEnv!;
      const floodlightActivityGroupId = floodlightActivityGroupIdFromEnv!;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dfareporting.FloodlightActivity("Signup", {
            profileId: profileId!,
            advertiserId,
            floodlightActivityGroupId,
            name: "alchemy-signup",
            notes: "signup conversion",
          });
        }),
      );

      expect(created.id).toEqual(expect.any(String));
      expect(created.name).toEqual("alchemy-signup");
      expect(created.notes).toEqual("signup conversion");
      expect(created.status).toEqual("ACTIVE");

      const fetched = yield* dfa.getFloodlightActivities({
        profileId: created.profileId,
        id: created.id,
      });
      expect(fetched.id).toEqual(created.id);
      expect(fetched.name).toContain("alchemy-id=");
      expect(fetched.notes).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dfareporting.FloodlightActivity("Signup", {
            profileId: created.profileId,
            advertiserId: created.advertiserId,
            floodlightActivityGroupId:
              created.floodlightActivityGroupId ?? floodlightActivityGroupId,
            id: created.id,
            name: "alchemy-signup-v2",
            notes: "signup conversion v2",
            status: "ARCHIVED_AND_DISABLED",
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.name).toEqual("alchemy-signup-v2");
      expect(updated.status).toEqual("ARCHIVED_AND_DISABLED");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.profileId, created.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
