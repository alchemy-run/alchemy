import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { expectGone, freshStack, secret, UNVALIDATED_ENDPOINT } from "../helpers.ts";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

const getCatalog = (catalogId: string) => galaxy.catalog.getMySQLCatalog({ catalogId });

const catalogExists = (catalogId: string) =>
  getCatalog(catalogId).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

const base = {
  connection: { type: "direct", host: UNVALIDATED_ENDPOINT },
  username: "galaxy",
  validate: false,
} as const;

test.provider(
  "create, reconfigure, rotate the password of, and delete a MySQL catalog",
  (stack) =>
    Effect.gen(function* () {
      yield* freshStack(stack);

      const created = yield* stack.deploy(
        StarburstGalaxy.Catalog.MySQLCatalog("Shop", { ...base, password: secret("mysql-v1") }),
      );
      const catalogId = created.catalogId;
      const live = yield* getCatalog(catalogId);
      expect(live.connectionType).toBe("direct");
      expect(live.connectionType === "direct" && live.host).toBe(UNVALIDATED_ENDPOINT);
      expect(live.port).toBe(3306);
      expect(live.username).toBe("galaxy");
      expect(created.connection).toEqual({ type: "direct", host: UNVALIDATED_ENDPOINT });

      // Settings converge in place.
      const reconfigured = yield* stack.deploy(
        StarburstGalaxy.Catalog.MySQLCatalog("Shop", {
          ...base,
          password: secret("mysql-v1"),
          description: "orders",
          readOnly: true,
          port: 3307,
          username: "reader",
        }),
      );
      expect(reconfigured.catalogId).toBe(catalogId);
      const updated = yield* getCatalog(catalogId);
      expect(updated.description).toBe("orders");
      expect(updated.readOnly).toBe(true);
      expect(updated.port).toBe(3307);
      expect(updated.username).toBe("reader");

      // A rotated password is sent though Galaxy never returns one; the catalog stays.
      const rotated = yield* stack.deploy(
        StarburstGalaxy.Catalog.MySQLCatalog("Shop", {
          ...base,
          password: secret("mysql-v2"),
          description: "orders",
          readOnly: true,
          port: 3307,
          username: "reader",
        }),
      );
      expect(rotated.catalogId).toBe(catalogId);
      // Galaxy masks secrets on read; the SDK keeps them Redacted.
      expect(Redacted.isRedacted((yield* getCatalog(catalogId)).password)).toBe(true);

      yield* stack.destroy();
      yield* expectGone(catalogExists(catalogId));
    }).pipe(Effect.scoped),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:catalog", "live"],
    timeout: 480_000,
  },
);
