import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import { expectGone, serviceAccountKey } from "../helpers.ts";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

// Galaxy asks Google whether the key's service account exists even with
// `validate: false`, so the lifecycle needs a real key: the JSON of a
// Google Cloud service account in STARBURST_GALAXY_TEST_GCS_KEY and a
// bucket it may read in STARBURST_GALAXY_TEST_GCS_BUCKET.
const gcsKey = process.env.STARBURST_GALAXY_TEST_GCS_KEY;
const gcsBucket = process.env.STARBURST_GALAXY_TEST_GCS_BUCKET;

const getCatalog = (catalogId: string) => galaxy.catalog.getGcsCatalog({ catalogId });

const catalogExists = (catalogId: string) =>
  getCatalog(catalogId).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

test.provider(
  "a key for a service account Google does not know is refused, even unvalidated",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const exit = yield* stack
        .deploy(
          StarburstGalaxy.GcsCatalog("Lake", {
            credentialsKey: serviceAccountKey("missing"),
            metastore: { type: "galaxy", defaultBucket: "alchemy-test", defaultDataLocation: "w" },
            validate: false,
          }),
        )
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(Exit.isFailure(exit) && exit.cause)).toContain("GCS account not found");
      yield* stack.destroy();
    }),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:catalog", "live"],
    timeout: 120_000,
  },
);

test.provider.skipIf(!gcsKey || !gcsBucket)(
  "create, reconfigure and delete a GCS catalog, and replace it on a metastore change",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const credentialsKey = Redacted.make(gcsKey!);
      const metastore = {
        type: "galaxy",
        defaultBucket: gcsBucket!,
        defaultDataLocation: "alchemy-test",
      } as const;

      const created = yield* stack.deploy(
        StarburstGalaxy.GcsCatalog("Lake", { credentialsKey, metastore, validate: false }),
      );
      const catalogId = created.catalogId;
      const live = yield* getCatalog(catalogId);
      expect(live.metastoreType).toBe("galaxy");

      const reconfigured = yield* stack.deploy(
        StarburstGalaxy.GcsCatalog("Lake", {
          credentialsKey,
          metastore: { ...metastore, defaultDataLocation: "alchemy-test/v2" },
          defaultTableFormat: "DELTA",
          validate: false,
        }),
      );
      expect(reconfigured.catalogId).toBe(catalogId);
      const updated = yield* getCatalog(catalogId);
      expect(updated.defaultTableFormat).toBe("DELTA");

      const hive = yield* stack.deploy(
        StarburstGalaxy.GcsCatalog("Lake", {
          credentialsKey,
          metastore: { type: "hive", host: "metastore.example.com" },
          validate: false,
        }),
      );
      expect(hive.catalogId).not.toBe(catalogId);
      yield* expectGone(catalogExists(catalogId));

      yield* stack.destroy();
      yield* expectGone(catalogExists(hive.catalogId));
    }),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:catalog", "live"],
    timeout: 180_000,
  },
);
