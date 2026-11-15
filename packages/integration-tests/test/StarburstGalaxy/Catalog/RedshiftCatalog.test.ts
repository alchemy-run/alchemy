import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";
import { expectGone, freshStack, secret, UNVALIDATED_ENDPOINT } from "../helpers.ts";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

const getCatalog = (catalogId: string) => galaxy.catalog.getRedshiftCatalog({ catalogId });

const catalogExists = (catalogId: string) =>
  getCatalog(catalogId).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

const endpoint = `${UNVALIDATED_ENDPOINT}:5439/dev`;

test.provider(
  "create a Redshift catalog with a password, and replace it with an access-key one",
  (stack) =>
    Effect.gen(function* () {
      yield* freshStack(stack);

      const created = yield* stack.deploy(
        StarburstGalaxy.Catalog.RedshiftCatalog("Warehouse", {
          endpoint,
          auth: { type: "basic", username: "galaxy", password: secret("redshift-v1") },
          validate: false,
        }),
      );
      const catalogId = created.catalogId;
      const live = yield* getCatalog(catalogId);
      expect(live.authType).toBe("basic");
      expect(live.endpoint).toBe(endpoint);
      expect(live.username).toBe("galaxy");

      const keyed = yield* stack.deploy(
        StarburstGalaxy.Catalog.RedshiftCatalog("Warehouse", {
          endpoint,
          auth: {
            type: "accessKey",
            username: "galaxy",
            accessKey: "AKIAALCHEMYTESTONLY0",
            secretKey: secret("redshift-key"),
            region: "us-east-1",
          },
          description: "warehouse",
          validate: false,
        }),
      );
      // Galaxy keeps a catalog's auth type on update: a new type is a new catalog.
      expect(keyed.catalogId).not.toBe(catalogId);
      yield* expectGone(catalogExists(catalogId));
      expect(keyed.authType).toBe("accessKey");
      const updated = yield* getCatalog(keyed.catalogId);
      expect(updated.authType).toBe("accessKey");
      expect(updated.authType === "accessKey" && updated.region).toBe("us-east-1");
      expect(updated.description).toBe("warehouse");

      yield* stack.destroy();
      yield* expectGone(catalogExists(keyed.catalogId));
    }).pipe(Effect.scoped),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:catalog", "live"],
    timeout: 480_000,
  },
);
