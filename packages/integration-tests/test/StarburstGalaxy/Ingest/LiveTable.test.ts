import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { freshStack, secret } from "../helpers.ts";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

// A live table writes Iceberg files: it needs a lakehouse catalog Galaxy can
// write to (an S3 bucket and credentials) and an existing schema in it.
// STARBURST_GALAXY_TEST_LAKE_CATALOG names such a catalog's ID, with
// STARBURST_GALAXY_TEST_LAKE_SCHEMA and an ingest source in
// STARBURST_GALAXY_TEST_LAKE_SOURCE (a file source over a bucket with JSON files).
const lake = {
  catalogId: process.env.STARBURST_GALAXY_TEST_LAKE_CATALOG,
  schemaName: process.env.STARBURST_GALAXY_TEST_LAKE_SCHEMA,
  sourceId: process.env.STARBURST_GALAXY_TEST_LAKE_SOURCE,
};

const liveTables = galaxy.liveTable.listLiveTables.items({}).pipe(Stream.runCollect);

test.provider(
  "a live table over a lake Galaxy cannot write is refused",
  (stack) =>
    Effect.gen(function* () {
      yield* freshStack(stack);
      const before = (yield* liveTables).length;

      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            const catalog = yield* StarburstGalaxy.Catalog.S3Catalog("Lake", {
              accessKey: "AKIAALCHEMYTESTONLY0",
              secretKey: secret("lake"),
              metastore: {
                type: "galaxy",
                defaultBucket: "noaa-ghcn-pds",
                defaultDataLocation: "warehouse",
              },
              validate: false,
            });
            const source = yield* StarburstGalaxy.Ingest.FileIngestSource("Weather", {
              bucket: "noaa-ghcn-pds",
              bucketCloudRegionId: "aws-us-east1",
              credentials: {
                type: "basicAwsCredentials",
                accessKeyId: "AKIAALCHEMYTESTONLY0",
                secretAccessKey: secret("lake"),
              },
            });
            return yield* StarburstGalaxy.Ingest.LiveTable("Raw", {
              catalogId: catalog.catalogId,
              schemaName: "ingest",
              tableName: "raw",
              typeProperties: {
                typeKey: "newFileIngestProperties",
                fileIngestSourceId: source.fileIngestSourceId,
                fileFormat: "Json",
                pollingIntervalInMinutes: 60,
              },
            });
          }),
        )
        .pipe(Effect.flip);
      expect(error._tag).toBe("Forbidden");
      expect(error.message).toContain("CREATE_TABLE");
      expect((yield* liveTables).length).toBe(before);

      yield* stack.destroy();
    }).pipe(Effect.scoped),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:ingest", "live"],
    timeout: 480_000,
  },
);

test.provider.skipIf(!lake.catalogId || !lake.schemaName || !lake.sourceId)(
  "load a lake table from files, wait for it to run, and replace it on a new polling interval",
  (stack) =>
    Effect.gen(function* () {
      yield* freshStack(stack);

      const table = (pollingIntervalInMinutes: number) =>
        StarburstGalaxy.Ingest.LiveTable("Raw", {
          catalogId: lake.catalogId!,
          schemaName: lake.schemaName!,
          tableName: "alchemy_live_test",
          typeProperties: {
            typeKey: "newFileIngestProperties",
            fileIngestSourceId: lake.sourceId!,
            fileFormat: "Json",
            pollingIntervalInMinutes,
          },
        });

      const created = yield* stack.deploy(table(60));
      expect(created.state).toBe("Running");
      const replaced = yield* stack.deploy(table(30));
      expect(replaced.liveTableId).not.toBe(created.liveTableId);
      expect(replaced.state).toBe("Running");

      yield* stack.destroy();
      const gone = yield* galaxy.liveTable
        .getLiveTable({ liveTableId: replaced.liveTableId })
        .pipe(Effect.flip);
      expect(gone._tag).toBe("NotFound");
    }).pipe(Effect.scoped),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:ingest", "live"],
    timeout: 1_200_000,
  },
);
