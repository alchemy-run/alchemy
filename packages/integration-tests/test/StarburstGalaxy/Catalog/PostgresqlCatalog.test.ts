import * as Neon from "@alchemy.run/neon";
import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { expectGone, freshStack, pinnedName, secret, UNVALIDATED_ENDPOINT } from "../helpers.ts";
import { expectFound } from "../lookup.ts";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });
const withNeon = Test.make({
  providers: Layer.mergeAll(StarburstGalaxy.providers(), Neon.providers()),
});

const getCatalog = (catalogId: string) => galaxy.catalog.getPostgresqlCatalog({ catalogId });

const catalogExists = (catalogId: string) =>
  getCatalog(catalogId).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

const unreachable = {
  endpoint: UNVALIDATED_ENDPOINT,
  databaseName: "app",
  username: "galaxy",
  validate: false,
} as const;

test.provider(
  "create, reconfigure, rotate the password, rename, look up and delete a catalog",
  (stack) =>
    Effect.gen(function* () {
      yield* freshStack(stack);
      const renamed = yield* pinnedName("pg");

      const created = yield* stack.deploy(
        StarburstGalaxy.Catalog.PostgresqlCatalog("Pg", { ...unreachable, password: secret("v1") }),
      );
      const catalogId = created.catalogId;
      const live = yield* getCatalog(catalogId);
      expect(live.name).toBe(created.name);
      expect(live.endpoint).toBe(unreachable.endpoint);
      expect(live.databaseName).toBe("app");
      expect(live.username).toBe("galaxy");
      expect(live.readOnly).toBe(false);
      // Generated names are SQL identifiers.
      expect(created.name).toMatch(/^[a-z0-9_]+$/);

      // Settings converge in place.
      const reconfigured = yield* stack.deploy(
        StarburstGalaxy.Catalog.PostgresqlCatalog("Pg", {
          ...unreachable,
          password: secret("v1"),
          description: "replica",
          readOnly: true,
          port: 6543,
        }),
      );
      expect(reconfigured.catalogId).toBe(catalogId);
      const updated = yield* getCatalog(catalogId);
      expect(updated.description).toBe("replica");
      expect(updated.readOnly).toBe(true);
      expect(updated.port).toBe(6543);

      // A new password is sent though Galaxy never returns one; the catalog stays.
      const rotated = yield* stack.deploy(
        StarburstGalaxy.Catalog.PostgresqlCatalog("Pg", {
          ...unreachable,
          password: secret("v2"),
          description: "replica",
          readOnly: true,
          port: 6543,
        }),
      );
      expect(rotated.catalogId).toBe(catalogId);

      // Nuke's `list` reports a catalog under its generated name.
      const provider = yield* Provider.findProvider(StarburstGalaxy.Catalog.PostgresqlCatalog);
      expect((yield* provider.list()).some((catalog) => catalog.catalogId === catalogId)).toBe(
        true,
      );

      // A rename keeps the catalog id.
      const named = yield* stack.deploy(
        StarburstGalaxy.Catalog.PostgresqlCatalog("Pg", {
          ...unreachable,
          name: renamed,
          password: secret("v2"),
        }),
      );
      expect(named.catalogId).toBe(catalogId);
      const renamedLive = yield* getCatalog(catalogId);
      expect(renamedLive.name).toBe(renamed);
      expect(renamedLive.readOnly).toBe(false);
      expect(renamedLive.description ?? "").toBe("");

      // `lookup` finds it by name; `list` leaves hand-named catalogs to their owners.
      yield* expectFound(
        StarburstGalaxy.Catalog.PostgresqlCatalog.lookup({ name: renamed }),
        named,
      );
      expect((yield* provider.list()).some((catalog) => catalog.catalogId === catalogId)).toBe(
        false,
      );

      yield* stack.destroy();
      yield* expectGone(catalogExists(catalogId));
    }).pipe(Effect.scoped),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:catalog", "live"],
    timeout: 480_000,
  },
);

withNeon.test.provider(
  "a catalog over a Neon project passes Galaxy's validation, and a wrong password fails it",
  (stack) =>
    Effect.gen(function* () {
      yield* freshStack(stack);

      const app = (password?: Redacted.Redacted<string>) =>
        Effect.gen(function* () {
          // The free plan caps history retention at 6 hours.
          const project = yield* Neon.Project("Project", { historyRetentionSeconds: 21600 });
          return yield* StarburstGalaxy.Catalog.PostgresqlCatalog("Neon", {
            endpoint: project.origin.host,
            databaseName: project.origin.database,
            username: project.origin.user,
            password: password ?? project.origin.password,
          });
        });

      const catalog = yield* stack.deploy(app());
      const validation = yield* galaxy.catalog.validatePostgresqlCatalog({
        catalogId: catalog.catalogId,
      });
      expect(validation.validationSuccessful).toBe(true);

      const wrong = yield* stack.deploy(app(secret("wrong-password"))).pipe(Effect.flip);
      expect(wrong).toBeInstanceOf(StarburstGalaxy.Catalog.CatalogValidationFailed);
      expect(
        wrong instanceof StarburstGalaxy.Catalog.CatalogValidationFailed && wrong.errors.length,
      ).toBeGreaterThan(0);

      yield* stack.destroy();
      yield* expectGone(catalogExists(catalog.catalogId));
    }).pipe(Effect.scoped),
  {
    tags: [
      "provider:starburst-galaxy",
      "provider:starburst-galaxy:catalog",
      "provider:neon",
      "live",
    ],
    timeout: 600_000,
  },
);
