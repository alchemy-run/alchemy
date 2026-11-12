import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type { Input, InputProps } from "alchemy/Input";
import * as Effect from "effect/Effect";
import { expectGone, freshStack, pinnedName, secret, UNVALIDATED_ENDPOINT } from "../helpers.ts";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

const productExists = (dataProductId: string) =>
  galaxy.dataProduct.getDataProduct({ dataProductId }).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

test.provider(
  "publish a schema as a data product, describe it, move its domain, rename it, and replace it on a new schema",
  (stack) =>
    Effect.gen(function* () {
      yield* freshStack(stack);
      const renamed = yield* pinnedName("product", "-");

      const app = (
        props: (refs: {
          dataDomainId: Input<string>;
          contact: Input<StarburstGalaxy.Contact>;
        }) => Partial<InputProps<StarburstGalaxy.DataProduct.DataProductProps>>,
      ) =>
        Effect.gen(function* () {
          const catalog = yield* StarburstGalaxy.Catalog.PostgresqlCatalog("Shop", {
            endpoint: UNVALIDATED_ENDPOINT,
            databaseName: "shop",
            username: "galaxy",
            password: secret("shop"),
            validate: false,
          });
          const domain = yield* StarburstGalaxy.DataProduct.DataDomain("Sales", {});
          const role = yield* StarburstGalaxy.Role.Role("Owner", {});
          const owner = yield* StarburstGalaxy.ServiceAccount.ServiceAccount("Contact", {
            role: role.roleId,
          });
          const product = yield* StarburstGalaxy.DataProduct.DataProduct("Orders", {
            summary: "Every order",
            catalogId: catalog.catalogId,
            schemaName: "orders",
            ...props({
              dataDomainId: domain.dataDomainId,
              contact: { userId: owner.serviceAccountId, email: owner.userName },
            }),
          });
          return { catalog, domain, owner, product };
        });

      const created = yield* stack.deploy(app(() => ({})));
      const dataProductId = created.product.dataProductId;
      const live = yield* galaxy.dataProduct.getDataProduct({ dataProductId });
      expect(live.summary).toBe("Every order");
      expect(live.catalog?.catalogId).toBe(created.catalog.catalogId);
      expect(live.schemaName).toBe("orders");
      const defaultDomain = yield* galaxy.dataProduct.getDataProductDataDomain({ dataProductId });
      expect(defaultDomain.name).toBe("Default");

      // Description, links, contacts and domain converge in place.
      const described = yield* stack.deploy(
        app((refs) => ({
          summary: "Every order placed",
          description: "One row per order.",
          links: [{ name: "Runbook", uri: "https://example.com/orders" }],
          contacts: [refs.contact],
          dataDomainId: refs.dataDomainId,
        })),
      );
      expect(described.product.dataProductId).toBe(dataProductId);
      const describedLive = yield* galaxy.dataProduct.getDataProduct({ dataProductId });
      expect(describedLive.summary).toBe("Every order placed");
      expect(describedLive.description).toBe("One row per order.");
      expect(describedLive.links).toEqual([{ name: "Runbook", uri: "https://example.com/orders" }]);
      expect(describedLive.contacts.map((c) => c.userId)).toEqual([
        described.owner.serviceAccountId,
      ]);
      expect(describedLive.dataDomainId).toBe(described.domain.dataDomainId);

      // A rename keeps the product.
      const named = yield* stack.deploy(
        app((refs) => ({ name: renamed, dataDomainId: refs.dataDomainId })),
      );
      expect(named.product.dataProductId).toBe(dataProductId);
      expect((yield* galaxy.dataProduct.getDataProduct({ dataProductId })).name).toBe(renamed);

      // Another schema is another product.
      const moved = yield* stack.deploy(
        app((refs) => ({ schemaName: "refunds", dataDomainId: refs.dataDomainId })),
      );
      expect(moved.product.dataProductId).not.toBe(dataProductId);
      expect(moved.product.schemaName).toBe("refunds");
      yield* expectGone(productExists(dataProductId));

      yield* stack.destroy();
      yield* expectGone(productExists(moved.product.dataProductId));
    }).pipe(Effect.scoped),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:data-product", "live"],
    timeout: 600_000,
  },
);
