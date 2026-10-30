import * as GCP from "@alchemy.run/gcp";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { deployProject } from "../../deployProject.ts";

/** Dataproc Metastore resources the generated bindings bind (the API is enabled by the suite). */
export const ProbeService = Effect.gen(function* () {
  const warehouse = yield* GCP.Storage.Bucket("ProbeWarehouse", {
    location: "US-CENTRAL1",
    forceDestroy: true,
  });
  return yield* GCP.Metastore.Service("ProbeService", {
    location: "us-central1",
    hiveMetastoreConfig: {
      version: "3.1.2",
      configOverrides: {
        "hive.metastore.warehouse.dir": Output.interpolate`gs://${warehouse.bucketName}/hive`,
      },
    },
    tier: "DEVELOPER",
  });
});
export const ProbeBackup = Effect.gen(function* () {
  const service = yield* ProbeService;
  return yield* GCP.Metastore.ServicesBackup("ProbeBackup", { service: service.name });
});
/** A federation needs at least one Dataproc Metastore backend; BigQuery joins it. */
export const ProbeFederation = Effect.gen(function* () {
  const project = yield* deployProject;
  const service = yield* ProbeService;
  return yield* GCP.Metastore.Federation("ProbeFederation", {
    location: "us-central1",
    version: "3.1.2",
    backendMetastores: {
      "1": { name: service.name, metastoreType: "DATAPROC_METASTORE" },
      "2": { name: `projects/${project}`, metastoreType: "BIGQUERY" },
    },
  });
});
