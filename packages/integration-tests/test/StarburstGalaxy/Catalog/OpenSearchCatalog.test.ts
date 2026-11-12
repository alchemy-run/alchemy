import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";
import { expectGone, freshStack, secret, UNVALIDATED_ENDPOINT } from "../helpers.ts";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

const getCatalog = (catalogId: string) => galaxy.catalog.getOpenSearchCatalog({ catalogId });

const catalogExists = (catalogId: string) =>
  getCatalog(catalogId).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

const endpoint = `https://${UNVALIDATED_ENDPOINT}`;

test.provider(
  "create an OpenSearch catalog with a user, and replace it with a SigV4 access-key one",
  (stack) =>
    Effect.gen(function* () {
      yield* freshStack(stack);

      const created = yield* stack.deploy(
        StarburstGalaxy.Catalog.OpenSearchCatalog("Logs", {
          endpoint,
          port: 9200,
          auth: { type: "basic", username: "galaxy", password: secret("opensearch-v1") },
          validate: false,
        }),
      );
      const catalogId = created.catalogId;
      const live = yield* getCatalog(catalogId);
      expect(live.authType).toBe("basic");
      expect(live.endpoint).toBe(endpoint);
      expect(live.port).toBe(9200);

      const keyed = yield* stack.deploy(
        StarburstGalaxy.Catalog.OpenSearchCatalog("Logs", {
          endpoint,
          auth: {
            type: "accessKey",
            accessKey: "AKIAALCHEMYTESTONLY0",
            secretKey: secret("opensearch-key"),
            region: "us-east-1",
          },
          validate: false,
        }),
      );
      // Galaxy keeps a catalog's auth type on update: a new type is a new catalog.
      expect(keyed.catalogId).not.toBe(catalogId);
      yield* expectGone(catalogExists(catalogId));
      const updated = yield* getCatalog(keyed.catalogId);
      expect(updated.authType).toBe("accessKey");
      expect(updated.port).toBe(443);

      yield* stack.destroy();
      yield* expectGone(catalogExists(keyed.catalogId));
    }).pipe(Effect.scoped),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:catalog", "live"],
    timeout: 480_000,
  },
);
