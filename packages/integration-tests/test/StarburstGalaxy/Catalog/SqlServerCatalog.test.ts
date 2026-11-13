import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";
import { expectGone, freshStack, pinnedName, secret, UNVALIDATED_ENDPOINT } from "../helpers.ts";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

const getCatalog = (catalogId: string) => galaxy.catalog.getSqlServerCatalog({ catalogId });

const catalogExists = (catalogId: string) =>
  getCatalog(catalogId).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

const base = {
  endpoint: UNVALIDATED_ENDPOINT,
  databaseName: "erp",
  username: "galaxy",
  validate: false,
} as const;

test.provider(
  "create, reconfigure, rotate the password of, rename and delete a SQL Server catalog",
  (stack) =>
    Effect.gen(function* () {
      yield* freshStack(stack);
      const renamed = yield* pinnedName("mssql");

      const created = yield* stack.deploy(
        StarburstGalaxy.Catalog.SqlServerCatalog("Erp", { ...base, password: secret("mssql-v1") }),
      );
      const catalogId = created.catalogId;
      const live = yield* getCatalog(catalogId);
      expect(live.endpoint).toBe(UNVALIDATED_ENDPOINT);
      expect(live.port).toBe(1433);
      expect(live.databaseName).toBe("erp");

      const reconfigured = yield* stack.deploy(
        StarburstGalaxy.Catalog.SqlServerCatalog("Erp", {
          ...base,
          password: secret("mssql-v2"),
          databaseName: "erp_v2",
          port: 1434,
        }),
      );
      expect(reconfigured.catalogId).toBe(catalogId);
      const updated = yield* getCatalog(catalogId);
      expect(updated.databaseName).toBe("erp_v2");
      expect(updated.port).toBe(1434);

      // A rename keeps the catalog id.
      const named = yield* stack.deploy(
        StarburstGalaxy.Catalog.SqlServerCatalog("Erp", {
          ...base,
          name: renamed,
          password: secret("mssql-v2"),
        }),
      );
      expect(named.catalogId).toBe(catalogId);
      expect((yield* getCatalog(catalogId)).name).toBe(renamed);

      yield* stack.destroy();
      yield* expectGone(catalogExists(catalogId));
    }).pipe(Effect.scoped),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:catalog", "live"],
    timeout: 480_000,
  },
);
