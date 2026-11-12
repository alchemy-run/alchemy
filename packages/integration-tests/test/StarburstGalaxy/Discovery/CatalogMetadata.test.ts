import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";
import { secret, UNVALIDATED_ENDPOINT } from "../helpers.ts";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

const contactsOf = (catalogId: string) =>
  galaxy.discovery
    .getCatalogMetadata({ catalogId })
    .pipe(Effect.map((metadata) => metadata.contacts.map((contact) => contact.userId)));

test.provider(
  "name a catalog's contacts, change them, and clear them on removal",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const app = (who: ReadonlyArray<"First" | "Second"> | undefined) =>
        Effect.gen(function* () {
          const role = yield* StarburstGalaxy.Role("Role", {});
          const first = yield* StarburstGalaxy.ServiceAccount("First", { role: role.roleId });
          const second = yield* StarburstGalaxy.ServiceAccount("Second", { role: role.roleId });
          const catalog = yield* StarburstGalaxy.PostgresqlCatalog("Crm", {
            endpoint: UNVALIDATED_ENDPOINT,
            databaseName: "crm",
            username: "galaxy",
            password: secret("crm"),
            validate: false,
          });
          const accounts = { First: first, Second: second };
          const metadata =
            who === undefined
              ? undefined
              : yield* StarburstGalaxy.CatalogMetadata("CrmContacts", {
                  catalogId: catalog.catalogId,
                  contacts: who.map((key) => ({
                    userId: accounts[key].serviceAccountId,
                    email: accounts[key].userName,
                  })),
                });
          return { first, second, catalog, metadata };
        });

      const set = yield* stack.deploy(app(["First"]));
      expect(yield* contactsOf(set.catalog.catalogId)).toEqual([set.first.serviceAccountId]);
      expect(set.metadata?.catalogName).toBe(set.catalog.name);

      const both = yield* stack.deploy(app(["First", "Second"]));
      expect([...(yield* contactsOf(both.catalog.catalogId))].sort()).toEqual(
        [both.first.serviceAccountId, both.second.serviceAccountId].sort(),
      );

      // Removing the resource clears the contacts and keeps the catalog.
      yield* stack.deploy(app(undefined));
      expect(yield* contactsOf(set.catalog.catalogId)).toEqual([]);

      yield* stack.destroy();
    }),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:discovery", "live"],
    timeout: 180_000,
  },
);
