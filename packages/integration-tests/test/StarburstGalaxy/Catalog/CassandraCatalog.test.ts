import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";
import { expectGone, secret, UNVALIDATED_ENDPOINT } from "../helpers.ts";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

const getCatalog = (catalogId: string) => galaxy.catalog.getCassandraCatalog({ catalogId });

const catalogExists = (catalogId: string) =>
  getCatalog(catalogId).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

test.provider(
  "create and reconfigure a Cassandra catalog, and replace it with an Astra DB one",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const cassandra = (localDatacenter: string) =>
        StarburstGalaxy.CassandraCatalog("Ledger", {
          deployment: {
            type: "apacheCassandra",
            contactPoints: UNVALIDATED_ENDPOINT,
            localDatacenter,
            username: "galaxy",
            password: secret("cassandra-v1"),
          },
          validate: false,
        });

      const created = yield* stack.deploy(cassandra("dc1"));
      const catalogId = created.catalogId;
      const live = yield* getCatalog(catalogId);
      expect(live.deploymentType).toBe("apacheCassandra");
      expect(live.deploymentType === "apacheCassandra" && live.port).toBe(9042);

      const moved = yield* stack.deploy(cassandra("dc2"));
      expect(moved.catalogId).toBe(catalogId);
      const updated = yield* getCatalog(catalogId);
      expect(updated.deploymentType === "apacheCassandra" && updated.localDatacenter).toBe("dc2");

      // Astra DB is another store: a new catalog, and the old one goes.
      const astra = yield* stack.deploy(
        StarburstGalaxy.CassandraCatalog("Ledger", {
          deployment: {
            type: "astraDB",
            databaseId: "00000000-0000-4000-8000-000000000000",
            region: "us-east-1",
            token: secret("astra"),
          },
          validate: false,
        }),
      );
      expect(astra.catalogId).not.toBe(catalogId);
      expect(astra.deployment).toEqual({
        type: "astraDB",
        databaseId: "00000000-0000-4000-8000-000000000000",
        region: "us-east-1",
      });
      yield* expectGone(catalogExists(catalogId));

      yield* stack.destroy();
      yield* expectGone(catalogExists(astra.catalogId));
    }),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:catalog", "live"],
    timeout: 180_000,
  },
);
