import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { deployProject } from "../../deployProject.ts";

/** MigrationCenter resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeAssetsExportJob = GCP.MigrationCenter.AssetsExportJob("ProbeAssetsExportJob", {
  location: "us-central1",
  fileFormat: "CSV",
});
export const ProbeGroup = GCP.MigrationCenter.Group("ProbeGroup", {
  location: "us-central1",
  displayName: "workloads",
  description: "production vms",
});
export const ProbePreferenceSet = GCP.MigrationCenter.PreferenceSet("ProbePreferenceSet", {
  location: "us-central1",
  displayName: "prod-gce",
  description: "gce defaults",
});
export const ProbeSource = GCP.MigrationCenter.Source("ProbeSource", {
  location: "us-central1",
  type: "SOURCE_TYPE_CUSTOM",
  displayName: "custom assets",
  description: "inventory feed",
  priority: 1,
});

export const ProbeImportJob = Effect.gen(function* () {
  const source = yield* GCP.MigrationCenter.Source("ProbeUploadSource", {
    location: "us-central1",
    type: "SOURCE_TYPE_UPLOAD",
    displayName: "probe-upload",
  });
  return yield* GCP.MigrationCenter.ImportJob("ProbeImportJob", {
    location: "us-central1",
    assetSource: source.name,
  });
});
export const ProbeReportConfig = Effect.gen(function* () {
  const group = yield* ProbeGroup;
  const prefs = yield* ProbePreferenceSet;
  return yield* GCP.MigrationCenter.ReportConfig("ProbeReportConfig", {
    location: "us-central1",
    displayName: "probe-tco",
    groupPreferencesetAssignments: [{ group: group.name, preferenceSet: prefs.name }],
  });
});

export const ProbeImportFile = Effect.gen(function* () {
  const job = yield* ProbeImportJob;
  return yield* GCP.MigrationCenter.ImportJobsImportDataFile("ProbeImportFile", {
    importJob: job.name,
    location: "us-central1",
    format: "IMPORT_JOB_FORMAT_RVTOOLS_CSV",
  });
});
export const ProbeReport = Effect.gen(function* () {
  const config = yield* ProbeReportConfig;
  return yield* GCP.MigrationCenter.ReportConfigsReport("ProbeReport", {
    reportConfig: config.name,
    location: "us-central1",
    type: "TOTAL_COST_OF_OWNERSHIP",
  });
});
export const ProbeDiscoveryClient = Effect.gen(function* () {
  const project = yield* deployProject;
  const source = yield* GCP.MigrationCenter.Source("ProbeScannerSource", {
    location: "us-central1",
    type: "SOURCE_TYPE_DISCOVERY_CLIENT",
    displayName: "scanner-source",
  });
  return yield* GCP.MigrationCenter.DiscoveryClient("ProbeDiscoveryClient", {
    location: "us-central1",
    source: source.name,
    serviceAccount: `alchemy-testing@${project}.iam.gserviceaccount.com`,
    displayName: "probe-agent",
  });
});
