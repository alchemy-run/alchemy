import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  consumptionService,
  logLevel,
  subscriptionId,
  tags,
  untilGone,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getProduct = (
  resourceGroupName: string,
  serviceName: string,
  productId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetProduct({
      subscriptionId,
      resourceGroupName,
      serviceName,
      productId,
    }),
  );

const program = (product?: {
  name: string;
  displayName: string;
  state: Azure.ApiManagement.ProductState;
}) =>
  Effect.gen(function* () {
    const { group, service } = yield* consumptionService;
    const created = product
      ? yield* Azure.ApiManagement.Product("Starter", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          name: product.name,
          displayName: product.displayName,
          description: "Starter tier",
          subscriptionRequired: true,
          state: product.state,
        })
      : undefined;
    return { group, service, product: created };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "create, update, replace, and delete a product",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({
          name: "alchemy-starter",
          displayName: "Starter",
          state: "notPublished",
        }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.product?.productName).toEqual("alchemy-starter");
      const observed = yield* getProduct(rg, svc, "alchemy-starter");
      expect(observed.properties?.displayName).toEqual("Starter");
      expect(observed.properties?.state).toEqual("notPublished");
      expect(observed.properties?.subscriptionRequired).toEqual(true);

      // In-place update: display name and publication state.
      yield* stack.deploy(
        program({
          name: "alchemy-starter",
          displayName: "Starter Plus",
          state: "published",
        }),
      );
      const updated = yield* getProduct(rg, svc, "alchemy-starter");
      expect(updated.properties?.displayName).toEqual("Starter Plus");
      expect(updated.properties?.state).toEqual("published");

      // Replacement: a new identifier creates a new product and deletes the old.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-starter-v2",
          // Product display names are unique per service, and the
          // replacement is created before the old product is deleted.
          displayName: "Starter v2",
          state: "published",
        }),
      );
      expect(replaced.product?.productName).toEqual("alchemy-starter-v2");
      expect(
        (yield* getProduct(rg, svc, "alchemy-starter-v2")).properties
          ?.displayName,
      ).toEqual("Starter v2");
      expect(yield* untilGone(getProduct(rg, svc, "alchemy-starter"))).toEqual(
        "gone",
      );

      // Removing the product deletes it while the service stays.
      yield* stack.deploy(program());
      expect(
        yield* untilGone(getProduct(rg, svc, "alchemy-starter-v2")),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
