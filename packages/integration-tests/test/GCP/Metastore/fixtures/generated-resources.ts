import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { deployProject } from "../../deployProject.ts";

/** Dataproc Metastore resources the generated bindings bind (the API is enabled by the suite). */
export const ProbeService = GCP.Metastore.Service("ProbeService", {
  location: "us-central1",
  hiveMetastoreConfig: { version: "3.1.2" },
  tier: "DEVELOPER",
});
export const ProbeBackup = Effect.gen(function* () {
  const service = yield* ProbeService;
  return yield* GCP.Metastore.ServicesBackup("ProbeBackup", { service: service.name });
});
export const ProbeFederation = Effect.gen(function* () {
  const project = yield* deployProject;
  return yield* GCP.Metastore.Federation("ProbeFederation", {
    location: "us-central1",
    version: "3.1.2",
    backendMetastores: { "1": { name: `projects/${project}`, metastoreType: "BIGQUERY" } },
  });
});
