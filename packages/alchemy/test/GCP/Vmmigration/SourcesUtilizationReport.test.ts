import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as vmmigration from "@distilled.cloud/gcp/vmmigration_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  dummyAws,
  hasGcpCreds,
  logLevel,
  project,
  runEntitlementProbe,
  runLifecycle,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsSourcesUtilizationReports on a missing report fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmmigration.getProjectsLocationsSourcesUtilizationReports({
          name: `projects/${project}/locations/us-central1/sources/alchemy-missing-source/utilizationReports/alchemy-missing-report`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runEntitlementProbe)(
  "createProjectsLocationsSourcesUtilizationReports without entitlement fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmmigration.createProjectsLocationsSourcesUtilizationReports({
          parent: `projects/${project}/locations/us-central1/sources/alchemy-missing-source`,
          utilizationReportId: "alchemy-report-probe",
          body: {
            displayName: "probe",
            timeFrame: "WEEK",
            vms: [{ vmId: "i-0123456789abcdef0" }],
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a vm migration utilization report",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* GCP.Vmmigration.Source("ReportSource", {
            aws: dummyAws,
          });
          return yield* GCP.Vmmigration.SourcesUtilizationReport("Week", {
            source: source.name,
            timeFrame: "WEEK",
            displayName: "weekly",
            vms: [{ vmId: "i-0123456789abcdef0" }],
          });
        }),
      );

      expect(created.utilizationReportId).toEqual(expect.any(String));
      expect(created.name).toContain("/utilizationReports/");
      expect(created.timeFrame).toEqual("WEEK");
      expect(created.displayName).toEqual("weekly");

      const fetched =
        yield* vmmigration.getProjectsLocationsSourcesUtilizationReports({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("alchemy-id=");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        vmmigration.getProjectsLocationsSourcesUtilizationReports({
          name: created.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
