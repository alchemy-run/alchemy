import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { expectGone, secret, testPrivateKey } from "../helpers.ts";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

const getCatalog = (catalogId: string) => galaxy.catalog.getSnowflakeCatalog({ catalogId });

const catalogExists = (catalogId: string) =>
  getCatalog(catalogId).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

const base = {
  accountIdentifier: "alchemytest-unreachable",
  databaseName: "FINANCE",
  username: "GALAXY",
  validate: false,
} as const;

test.provider(
  "create a Snowflake catalog with a password, move it to key-pair auth, and delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        StarburstGalaxy.SnowflakeCatalog("Finance", {
          ...base,
          auth: { type: "password", password: secret("snowflake-v1") },
        }),
      );
      const catalogId = created.catalogId;
      const live = yield* getCatalog(catalogId);
      expect(live.authenticationType).toBe("password");
      expect(live.accountIdentifier).toBe(base.accountIdentifier);

      // The auth type, warehouse and role converge in place.
      const keyed = yield* stack.deploy(
        StarburstGalaxy.SnowflakeCatalog("Finance", {
          ...base,
          auth: { type: "key", privateKey: Redacted.make(testPrivateKey) },
          warehouse: "COMPUTE_WH",
          role: "ANALYST",
        }),
      );
      expect(keyed.catalogId).toBe(catalogId);
      expect(keyed.authenticationType).toBe("key");
      const updated = yield* getCatalog(catalogId);
      expect(updated.authenticationType).toBe("key");
      expect(updated.warehouse).toBe("COMPUTE_WH");
      expect(updated.role).toBe("ANALYST");

      yield* stack.destroy();
      yield* expectGone(catalogExists(catalogId));
    }),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:catalog", "live"],
    timeout: 180_000,
  },
);
