import * as GCP from "@alchemy.run/gcp";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { deployProject } from "../../deployProject.ts";

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

const LandingBucket = GCP.Storage.Bucket("ProbeLanding", {
  location: "US-CENTRAL1",
  forceDestroy: true,
});
export const ProbeAsset = Effect.gen(function* () {
  const bucket = yield* LandingBucket;
  const zone = yield* ProbeZone;
  return yield* GCP.Dataplex.LakesAsset("ProbeAsset", {
    zone: zone.name,
    resourceSpec: {
      type: "STORAGE_BUCKET",
      name: Output.interpolate`projects/${bucket.projectNumber}/buckets/${bucket.bucketName}`,
    },
    discoverySpec: { enabled: false },
  });
});
export const ProbeMetadataFeed = Effect.gen(function* () {
  const topic = yield* GCP.PubSub.Topic("ProbeCatalogFeed", {});
  return yield* GCP.Dataplex.MetadataFeed("ProbeMetadataFeed", {
    location: "us-central1",
    pubsubTopic: topic.name,
  });
});
export const ProbeEntity = Effect.gen(function* () {
  const bucket = yield* LandingBucket;
  const zone = yield* ProbeZone;
  const asset = yield* ProbeAsset;
  return yield* GCP.Dataplex.LakesEntity("ProbeEntity", {
    zone: zone.name,
    asset: asset.assetId,
    type: "TABLE",
    system: "CLOUD_STORAGE",
    dataPath: Output.interpolate`gs://${bucket.bucketName}/events`,
    format: { format: "PARQUET" },
    schema: { userManaged: true, fields: [{ name: "id", type: "STRING", mode: "REQUIRED" }] },
  });
});
export const ProbePartition = Effect.gen(function* () {
  const bucket = yield* LandingBucket;
  const entity = yield* ProbeEntity;
  return yield* GCP.Dataplex.LakesEntitiesPartition("ProbePartition", {
    entity: entity.name,
    values: ["2024-01-01"],
    location: Output.interpolate`gs://${bucket.bucketName}/events/dt=2024-01-01`,
  });
});
/** An on-demand task: it only runs when RunTask is called. */
export const ProbeTask = Effect.gen(function* () {
  const project = yield* deployProject;
  const bucket = yield* LandingBucket;
  const lake = yield* ProbeLake;
  return yield* GCP.Dataplex.LakesTask("ProbeTask", {
    lake: lake.name,
    triggerSpec: { type: "ON_DEMAND" },
    executionSpec: {
      serviceAccount: `alchemy-testing@${project}.iam.gserviceaccount.com`,
      args: { output_location: Output.interpolate`gs://${bucket.bucketName}/task-out` },
    },
    spark: { sqlScript: "SELECT 1" },
  });
});
export const ProbeEntryLink = Effect.gen(function* () {
  const type = yield* ProbeEntryType;
  const group = yield* ProbeEntryGroup;
  const left = yield* ProbeEntry;
  const right = yield* GCP.Dataplex.EntryGroupsEntry("ProbeRightEntry", {
    entryGroup: group.name,
    entryType: type.name,
  });
  return yield* GCP.Dataplex.EntryGroupsEntryLink("ProbeEntryLink", {
    entryGroup: group.name,
    entryLinkType: "projects/dataplex-types/locations/global/entryLinkTypes/related",
    entryReferences: [
      { name: left.name, type: "UNSPECIFIED" },
      { name: right.name, type: "UNSPECIFIED" },
    ],
  });
});
export const ProbeDataAsset = Effect.gen(function* () {
  const dataset = yield* GCP.BigQuery.Dataset("ProbeProductData", {
    location: "US-CENTRAL1",
    forceDestroy: true,
  });
  const product = yield* ProbeDataProduct;
  return yield* GCP.Dataplex.DataProductsDataAsset("ProbeDataAsset", {
    parent: product.name,
    resource: Output.interpolate`//bigquery.googleapis.com/projects/${dataset.project}/datasets/${dataset.datasetId}`,
  });
});
