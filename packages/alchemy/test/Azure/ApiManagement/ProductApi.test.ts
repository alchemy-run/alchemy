import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  consumptionService,
  logLevel,
  subscriptionId,
  tags,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

/** Names of the APIs in the product, read out of band. */
const productApis = (
  resourceGroupName: string,
  serviceName: string,
  productId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.ListProductApiByProduct({
      subscriptionId,
      resourceGroupName,
      serviceName,
      productId,
    }),
  ).pipe(Effect.map((page) => (page.value ?? []).map((api) => api.name ?? "")));

/** Poll until the product's APIs match `expected` (bounded). */
const untilApis = (
  resourceGroupName: string,
  serviceName: string,
  productId: string,
  expected: string[],
) =>
  productApis(resourceGroupName, serviceName, productId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (names) =>
        names.length === expected.length &&
        expected.every((name) => names.includes(name)),
      times: 10,
    }),
  );

const program = (linkedApi?: "alchemy-pa-one" | "alchemy-pa-two") =>
  Effect.gen(function* () {
    const { group, service } = yield* consumptionService;
    const product = yield* Azure.ApiManagement.Product("Starter", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-pa-product",
      displayName: "Product API test",
      subscriptionRequired: false,
      state: "published",
    });
    // Both APIs stay deployed across the replacement step.
    const one = yield* Azure.ApiManagement.Api("One", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-pa-one",
      path: "pa-one",
      serviceUrl: "https://example.com",
    });
    const two = yield* Azure.ApiManagement.Api("Two", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-pa-two",
      path: "pa-two",
      serviceUrl: "https://example.com",
    });
    const link = linkedApi
      ? yield* Azure.ApiManagement.ProductApi("Link", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          productName: product.productName,
          apiName: linkedApi === "alchemy-pa-one" ? one.apiName : two.apiName,
        })
      : undefined;
    return { group, service, product, link };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "add, replace, and remove an API in a product",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program("alchemy-pa-one"));
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      const product = first.product.productName;
      expect(first.link?.apiName).toEqual("alchemy-pa-one");
      expect(first.link?.productApiId).toContain(
        `/products/${product}/apis/alchemy-pa-one`,
      );
      expect(yield* productApis(rg, svc, product)).toEqual(["alchemy-pa-one"]);

      // Redeploying the same link is a no-op.
      yield* stack.deploy(program("alchemy-pa-one"));
      expect(yield* productApis(rg, svc, product)).toEqual(["alchemy-pa-one"]);

      // Replacement: link the other API; the old link is removed.
      const replaced = yield* stack.deploy(program("alchemy-pa-two"));
      expect(replaced.link?.apiName).toEqual("alchemy-pa-two");
      expect(yield* untilApis(rg, svc, product, ["alchemy-pa-two"])).toEqual([
        "alchemy-pa-two",
      ]);

      // Removing the link leaves the product without APIs.
      yield* stack.deploy(program());
      expect(yield* untilApis(rg, svc, product, [])).toEqual([]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
