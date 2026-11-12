import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";
import { expectGone, secret } from "../helpers.ts";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

const getCatalog = (catalogId: string) => galaxy.catalog.getS3Catalog({ catalogId });

const catalogExists = (catalogId: string) =>
  getCatalog(catalogId).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

// Stored without Galaxy's connection check: the keys are never used. Galaxy
// still requires the default bucket to exist, so it names a public AWS Open
// Data bucket the catalog never writes to.
const LAKE_BUCKET = "noaa-ghcn-pds";

const base = {
  accessKey: "AKIAALCHEMYTESTONLY0",
  validate: false,
} as const;

test.provider(
  "create a Galaxy-metastore catalog, reconfigure it, rotate its key, and replace it with a Glue one",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const galaxyMetastore = {
        type: "galaxy",
        defaultBucket: LAKE_BUCKET,
        defaultDataLocation: "warehouse",
      } as const;

      const created = yield* stack.deploy(
        StarburstGalaxy.S3Catalog("Lake", {
          ...base,
          secretKey: secret("s3-v1"),
          metastore: galaxyMetastore,
        }),
      );
      const catalogId = created.catalogId;
      const live = yield* getCatalog(catalogId);
      expect(live.metastoreType).toBe("galaxy");
      expect(live.accessKey).toBe(base.accessKey);
      expect(created.metastore).toEqual(galaxyMetastore);

      // Settings converge in place.
      const reconfigured = yield* stack.deploy(
        StarburstGalaxy.S3Catalog("Lake", {
          ...base,
          secretKey: secret("s3-v1"),
          description: "lakehouse",
          defaultTableFormat: "DELTA",
          metastore: { ...galaxyMetastore, defaultDataLocation: "warehouse/v2" },
        }),
      );
      expect(reconfigured.catalogId).toBe(catalogId);
      const updated = yield* getCatalog(catalogId);
      expect(updated.description).toBe("lakehouse");
      expect(updated.defaultTableFormat).toBe("DELTA");
      expect(updated.metastoreType === "galaxy" && updated.defaultDataLocation).toBe(
        "warehouse/v2",
      );

      // A rotated secret key is sent; the catalog stays.
      const rotated = yield* stack.deploy(
        StarburstGalaxy.S3Catalog("Lake", {
          ...base,
          secretKey: secret("s3-v2"),
          description: "lakehouse",
          defaultTableFormat: "DELTA",
          metastore: { ...galaxyMetastore, defaultDataLocation: "warehouse/v2" },
        }),
      );
      expect(rotated.catalogId).toBe(catalogId);

      // Another metastore type is a new catalog; the old one goes.
      const glue = yield* stack.deploy(
        StarburstGalaxy.S3Catalog("Lake", {
          ...base,
          secretKey: secret("s3-v2"),
          metastore: {
            type: "glue",
            region: "us-east-1",
            defaultBucket: LAKE_BUCKET,
            defaultDataLocation: "iceberg",
          },
        }),
      );
      expect(glue.catalogId).not.toBe(catalogId);
      const glueLive = yield* getCatalog(glue.catalogId);
      expect(glueLive.metastoreType).toBe("glue");
      yield* expectGone(catalogExists(catalogId));

      yield* stack.destroy();
      yield* expectGone(catalogExists(glue.catalogId));
    }),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:catalog", "live"],
    timeout: 180_000,
  },
);
