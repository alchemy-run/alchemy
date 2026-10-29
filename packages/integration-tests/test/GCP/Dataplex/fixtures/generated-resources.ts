import * as GCP from "@alchemy.run/gcp";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";

/** Dataplex resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeDataProduct = GCP.Dataplex.DataProduct("ProbeDataProduct", {
  location: "us-central1",
  displayName: "Sales mart",
  description: "product a",
  ownerEmails: ["owner@example.com"],
});
export const ProbeEntryGroup = GCP.Dataplex.EntryGroup("ProbeEntryGroup", {
  location: "us-central1",
  displayName: "catalog a",
  description: "group a",
});
export const ProbeEntryType = GCP.Dataplex.EntryType("ProbeEntryType", {
  location: "us-central1",
  displayName: "table a",
  description: "type a",
  typeAliases: ["TABLE"],
  platform: "GCS",
  system: "Cloud Storage",
});
export const ProbeGlossary = GCP.Dataplex.Glossary("ProbeGlossary", {
  location: "us-central1",
  displayName: "glossary a",
  description: "glossary a",
});
export const ProbeLake = GCP.Dataplex.Lake("ProbeLake", {
  location: "us-central1",
  displayName: "lake a",
  description: "lake a",
});

export const ProbeAspectType = GCP.Dataplex.AspectType("ProbeAspectType", {
  location: "us-central1",
  metadataTemplate: {
    name: "schema",
    type: "record",
    recordFields: [{ name: "owner", type: "string", index: 1 }],
  },
});
export const ProbeEntry = Effect.gen(function* () {
  const type = yield* ProbeEntryType;
  const group = yield* ProbeEntryGroup;
  return yield* GCP.Dataplex.EntryGroupsEntry("ProbeEntry", {
    entryGroup: group.name,
    entryType: type.name,
    fullyQualifiedName: "custom:probe_orders",
    entrySource: { system: "custom", platform: "alchemy", displayName: "probe orders" },
  });
});
export const ProbeCategory = Effect.gen(function* () {
  const glossary = yield* ProbeGlossary;
  return yield* GCP.Dataplex.GlossariesCategory("ProbeCategory", {
    glossary: glossary.name,
    displayName: "finance",
  });
});
export const ProbeTerm = Effect.gen(function* () {
  const glossary = yield* ProbeGlossary;
  return yield* GCP.Dataplex.GlossariesTerm("ProbeTerm", {
    glossary: glossary.name,
    displayName: "Customer",
  });
});
export const ProbeZone = Effect.gen(function* () {
  const lake = yield* ProbeLake;
  return yield* GCP.Dataplex.LakesZone("ProbeZone", {
    lake: lake.name,
    type: "RAW",
    locationType: "SINGLE_REGION",
    discoverySpec: { enabled: false },
  });
});
export const ProbeScan = Effect.gen(function* () {
  const dataset = yield* GCP.BigQuery.Dataset("ProbeScanData", {
    location: "US-CENTRAL1",
    forceDestroy: true,
  });
  const table = yield* GCP.BigQuery.Table("ProbeScanTable", {
    datasetId: dataset.datasetId,
    schema: [{ name: "id", type: "STRING" }],
  });
  return yield* GCP.Dataplex.DataScan("ProbeScan", {
    location: "us-central1",
    data: {
      resource: Output.interpolate`//bigquery.googleapis.com/projects/${table.project}/datasets/${table.datasetId}/tables/${table.tableId}`,
    },
    dataProfileSpec: { samplingPercent: 100 },
  });
});
