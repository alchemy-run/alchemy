import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { expectGone, serviceAccountKey } from "../helpers.ts";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

const getCatalog = (catalogId: string) => galaxy.catalog.getBigQueryCatalog({ catalogId });

const catalogExists = (catalogId: string) =>
  getCatalog(catalogId).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

test.provider(
  "create, point at another project, rotate the key of, and delete a BigQuery catalog",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // A well-formed key for an account that does not exist: Galaxy stores
      // it without checking when `validate` is off.
      const created = yield* stack.deploy(
        StarburstGalaxy.BigQueryCatalog("Warehouse", {
          credentialsKey: serviceAccountKey("v1"),
          validate: false,
        }),
      );
      const catalogId = created.catalogId;
      const live = yield* getCatalog(catalogId);
      expect(live.name).toBe(created.name);
      expect(live.projectId).toBeUndefined();

      const pointed = yield* stack.deploy(
        StarburstGalaxy.BigQueryCatalog("Warehouse", {
          credentialsKey: serviceAccountKey("v2"),
          projectId: "bigquery-public-data",
          parentProjectId: "alchemy-test-billing",
          readOnly: true,
          validate: false,
        }),
      );
      expect(pointed.catalogId).toBe(catalogId);
      const updated = yield* getCatalog(catalogId);
      expect(updated.projectId).toBe("bigquery-public-data");
      expect(updated.parentProjectId).toBe("alchemy-test-billing");
      expect(updated.readOnly).toBe(true);
      expect(Redacted.isRedacted(updated.credentialsKey)).toBe(true);

      yield* stack.destroy();
      yield* expectGone(catalogExists(catalogId));
    }),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:catalog", "live"],
    timeout: 180_000,
  },
);
