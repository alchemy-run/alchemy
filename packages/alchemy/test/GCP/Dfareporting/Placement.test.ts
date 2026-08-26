import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dfa from "@distilled.cloud/gcp/dfareporting_v5";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  campaignIdFromEnv,
  hasGcpCreds,
  logLevel,
  resolveProfileId,
  runLifecycle,
  siteIdFromEnv,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const campaignId = campaignIdFromEnv;
const siteId = siteIdFromEnv;
const runPlacementLifecycle = runLifecycle && !!campaignId && !!siteId;

const waitUntilArchived = (profileId: string, id: string) =>
  dfa.getPlacements({ profileId, id }).pipe(
    Effect.map((placement) =>
      placement.activeStatus === "PLACEMENT_STATUS_ARCHIVED" ||
      placement.activeStatus === "PLACEMENT_STATUS_PERMANENTLY_ARCHIVED"
        ? ("gone" as const)
        : ("found" as const),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getPlacements on a missing placement fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dfa.getPlacements({ profileId: "1", id: "1" }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_DFAREPORTING)(
  "insertPlacements without Campaign Manager access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dfa.insertPlacements({
          profileId: "1",
          body: {
            name: "alchemy-dfareporting-placement-probe",
            campaignId: "1",
            siteId: "1",
            compatibility: "DISPLAY",
            paymentSource: "PLACEMENT_AGENCY_PAID",
            size: { width: 1, height: 1 },
            tagFormats: ["PLACEMENT_TAG_STANDARD"],
            pricingSchedule: {
              pricingType: "PRICING_TYPE_CPM",
              startDate: "2030-01-01",
              endDate: "2030-01-31",
            },
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runPlacementLifecycle)(
  "create, update, and archive a placement",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const profileId = yield* resolveProfileId();
      expect(profileId).toEqual(expect.any(String));

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dfareporting.Placement("House", {
            profileId: profileId!,
            campaignId: campaignId!,
            siteId: siteId!,
            name: "alchemy-house",
            compatibility: "DISPLAY",
            size: { width: 1, height: 1 },
          });
        }),
      );

      expect(created.id).toEqual(expect.any(String));
      expect(created.profileId).toEqual(profileId);
      expect(created.name).toEqual("alchemy-house");
      expect(created.campaignId).toEqual(campaignId);

      const fetched = yield* dfa.getPlacements({
        profileId: created.profileId,
        id: created.id,
      });
      expect(fetched.id).toEqual(created.id);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dfareporting.Placement("House", {
            profileId: created.profileId,
            id: created.id,
            campaignId: created.campaignId,
            siteId: created.siteId,
            name: "alchemy-house-v2",
          });
        }),
      );
      expect(updated.id).toEqual(created.id);
      expect(updated.name).toEqual("alchemy-house-v2");

      yield* stack.destroy();

      const gone = yield* waitUntilArchived(created.profileId, created.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
