import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";
import { expectGone, freshStack, secret, UNVALIDATED_ENDPOINT } from "../helpers.ts";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

const getCatalog = (catalogId: string) => galaxy.catalog.getMongoDBCatalog({ catalogId });

const catalogExists = (catalogId: string) =>
  getCatalog(catalogId).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

const base = {
  connection: { type: "direct", hosts: UNVALIDATED_ENDPOINT },
  username: "galaxy",
  validate: false,
} as const;

test.provider(
  "create, reconfigure, rotate the password of, and delete a MongoDB catalog",
  (stack) =>
    Effect.gen(function* () {
      yield* freshStack(stack);

      const created = yield* stack.deploy(
        StarburstGalaxy.Catalog.MongoDBCatalog("Events", {
          ...base,
          regions: ["aws-us-east1"],
          password: secret("mongo-v1"),
        }),
      );
      const catalogId = created.catalogId;
      const live = yield* getCatalog(catalogId);
      expect(live.connectionType).toBe("direct");
      expect(live.regions).toEqual(["aws-us-east1"]);
      expect(live.tlsEnabled).toBe(true);
      expect(live.dnsSeedListEnabled).toBe(false);

      const reconfigured = yield* stack.deploy(
        StarburstGalaxy.Catalog.MongoDBCatalog("Events", {
          ...base,
          regions: ["aws-us-east1", "aws-us-west2"],
          password: secret("mongo-v2"),
          dnsSeedListEnabled: true,
          description: "events",
        }),
      );
      expect(reconfigured.catalogId).toBe(catalogId);
      const updated = yield* getCatalog(catalogId);
      expect([...updated.regions].sort()).toEqual(["aws-us-east1", "aws-us-west2"]);
      expect(updated.dnsSeedListEnabled).toBe(true);
      expect(updated.description).toBe("events");

      yield* stack.destroy();
      yield* expectGone(catalogExists(catalogId));
    }).pipe(Effect.scoped),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:catalog", "live"],
    timeout: 480_000,
  },
);
