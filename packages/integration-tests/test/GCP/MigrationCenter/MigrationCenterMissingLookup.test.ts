import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:migrationcenter", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-assets-export-job": GCP.MigrationCenter.AssetsExportJob.lookup({
          assetsExportJobId: name,
        }).name,
        "missing-discovery-client": GCP.MigrationCenter.DiscoveryClient.lookup({
          discoveryClientId: name,
        }).name,
        "missing-group": GCP.MigrationCenter.Group.lookup({ groupId: name }).name,
        "missing-import-job": GCP.MigrationCenter.ImportJob.lookup({ importJobId: name }).name,
        "missing-import-jobs-import-data-file": GCP.MigrationCenter.ImportJobsImportDataFile.lookup(
          { importDataFileId: name, importJob: name },
        ).name,
        "missing-preference-set": GCP.MigrationCenter.PreferenceSet.lookup({
          preferenceSetId: name,
        }).name,
        "missing-report-config": GCP.MigrationCenter.ReportConfig.lookup({ reportConfigId: name })
          .name,
        "missing-report-configs-report": GCP.MigrationCenter.ReportConfigsReport.lookup({
          reportId: name,
          reportConfig: name,
        }).name,
        "missing-source": GCP.MigrationCenter.Source.lookup({ sourceId: name }).name,
      });
    }),
  { tags, timeout: 195000 },
);
