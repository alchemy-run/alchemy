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

const getLink = (resourceGroupName: string, serviceName: string, id: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetProductApiLink({
      subscriptionId,
      resourceGroupName,
      serviceName,
      productId: "alchemy-link-product",
      apiLinkId: id,
    }),
  );

const program = (target?: "one" | "two") =>
  Effect.gen(function* () {
    const { group, service } = yield* consumptionService;
    const product = yield* Azure.ApiManagement.Product("Product", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-link-product",
      displayName: "Link product",
    });
    // Both APIs stay deployed across the replacement step.
    const one = yield* Azure.ApiManagement.Api("One", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-link-one",
      path: "one",
      serviceUrl: "https://example.com",
    });
    const two = yield* Azure.ApiManagement.Api("Two", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-link-two",
      path: "two",
      serviceUrl: "https://example.com",
    });
    const link = target
      ? yield* Azure.ApiManagement.ProductApiLink("Link", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          productName: product.productName,
          apiName: target === "one" ? one.apiName : two.apiName,
          name: `link-${target}`,
        })
      : undefined;
    return { group, service, link };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "create, replace, and delete a product API link",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program("one"));
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.link?.apiName).toEqual("alchemy-link-one");
      const firstId = "link-one";
      expect((yield* getLink(rg, svc, firstId)).name).toEqual(firstId);

      // Replacement: another target creates the new link, deletes the old.
      const replaced = yield* stack.deploy(program("two"));
      expect(replaced.link?.apiName).toEqual("alchemy-link-two");
      const secondId = "link-two";
      expect((yield* getLink(rg, svc, secondId)).name).toEqual(secondId);
      expect(yield* untilGone(getLink(rg, svc, firstId))).toEqual("gone");

      // Removing the resource deletes the link.
      yield* stack.deploy(program());
      expect(yield* untilGone(getLink(rg, svc, secondId))).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
