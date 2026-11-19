import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:vmmigration", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-group": GCP.VMMigration.Group.lookup({ groupId: name }).name,
        "missing-image-import": GCP.VMMigration.ImageImport.lookup({ imageImportId: name }).name,
        "missing-source": GCP.VMMigration.Source.lookup({ sourceId: name }).name,
        "missing-sources-datacenter-connector": GCP.VMMigration.SourcesDatacenterConnector.lookup({
          datacenterConnectorId: name,
          source: name,
        }).name,
        "missing-sources-disk-migration-job": GCP.VMMigration.SourcesDiskMigrationJob.lookup({
          diskMigrationJobId: name,
          source: name,
        }).name,
        "missing-sources-migrating-vm": GCP.VMMigration.SourcesMigratingVm.lookup({
          migratingVmId: name,
          source: name,
        }).name,
        "missing-sources-utilization-report": GCP.VMMigration.SourcesUtilizationReport.lookup({
          utilizationReportId: name,
          source: name,
        }).name,
        "missing-target": GCP.VMMigration.Target.lookup({ targetProjectId: name }).name,
      });
    }),
  { tags, timeout: 180000 },
);
