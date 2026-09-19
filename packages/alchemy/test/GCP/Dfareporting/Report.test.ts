import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dfa from "@distilled.cloud/gcp/dfareporting_v5";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  hasGcpCreds,
  logLevel,
  resolveProfileId,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (profileId: string, reportId: string) =>
  dfa.getReports({ profileId, reportId }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getReports on a missing report fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dfa.getReports({ profileId: "1", reportId: "1" }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_DFAREPORTING)(
  "insertReports without Campaign Manager access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dfa.insertReports({
          profileId: "1",
          body: {
            name: "alchemy-dfareporting-probe",
            type: "STANDARD",
            criteria: {
              dateRange: { relativeDateRange: "LAST_7_DAYS" },
              dimensions: [{ name: "dfa:date" }],
              metricNames: ["dfa:impressions"],
            },
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a report",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const profileId = yield* resolveProfileId();
      expect(profileId).toEqual(expect.any(String));

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dfareporting.Report("Weekly", {
            profileId: profileId!,
            name: "alchemy-weekly",
            type: "STANDARD",
            criteria: {
              dateRange: { relativeDateRange: "LAST_7_DAYS" },
              dimensions: [{ name: "dfa:date" }],
              metricNames: ["dfa:impressions"],
            },
          });
        }),
      );

      expect(created.id).toEqual(expect.any(String));
      expect(created.profileId).toEqual(profileId);
      expect(created.name).toEqual("alchemy-weekly");
      expect(created.type).toEqual("STANDARD");

      const fetched = yield* dfa.getReports({
        profileId: created.profileId,
        reportId: created.id,
      });
      expect(fetched.id).toEqual(created.id);
      expect(fetched.name).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dfareporting.Report("Weekly", {
            profileId: created.profileId,
            id: created.id,
            name: "alchemy-weekly-v2",
            type: "STANDARD",
            criteria: {
              dateRange: { relativeDateRange: "LAST_30_DAYS" },
              dimensions: [{ name: "dfa:date" }],
              metricNames: ["dfa:impressions"],
            },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.name).toEqual("alchemy-weekly-v2");
      expect(updated.criteria?.dateRange?.relativeDateRange).toEqual(
        "LAST_30_DAYS",
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.profileId, created.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
