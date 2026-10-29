import * as GCP from "@alchemy.run/gcp";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";

/** BigLake resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeCatalog = GCP.BigLake.Catalog("ProbeCatalog", {
  location: "us-central1",
});

const Warehouse = GCP.Storage.Bucket("ProbeWarehouse", {
  location: "US-CENTRAL1",
  forceDestroy: true,
});
export const ProbeDatabase = Effect.gen(function* () {
  const catalog = yield* ProbeCatalog;
  const bucket = yield* Warehouse;
  return yield* GCP.BigLake.CatalogsDatabase("ProbeDatabase", {
    catalog: catalog.name,
    locationUri: Output.interpolate`gs://${bucket.bucketName}/warehouse`,
  });
});
export const ProbeTable = Effect.gen(function* () {
  const database = yield* ProbeDatabase;
  const bucket = yield* Warehouse;
  return yield* GCP.BigLake.CatalogsDatabasesTable("ProbeTable", {
    database: database.name,
    hiveOptions: {
      tableType: "MANAGED_TABLE",
      storageDescriptor: {
        locationUri: Output.interpolate`gs://${bucket.bucketName}/events`,
        inputFormat: "org.apache.hadoop.mapred.SequenceFileInputFormat",
        outputFormat: "org.apache.hadoop.hive.ql.io.HiveSequenceFileOutputFormat",
      },
    },
  });
});
