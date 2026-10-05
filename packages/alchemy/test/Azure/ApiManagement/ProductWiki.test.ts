import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import {
  basicV2Service,
  logLevel,
  subscriptionId,
  tags,
  untilGone,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getWiki = (
  resourceGroupName: string,
  serviceName: string,
  productId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetProductWiki({
      subscriptionId,
      resourceGroupName,
      serviceName,
      productId,
    }),
  );

const program = (pages?: ("one" | "two")[]) =>
  Effect.gen(function* () {
    const { group, service } = yield* basicV2Service;
    const product = yield* Azure.ApiManagement.Product("Starter", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-wiki-product",
      displayName: "Wiki product",
    });
    const one = yield* Azure.ApiManagement.Documentation("One", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-wiki-one",
      title: "One",
      content: "# One",
    });
    const two = yield* Azure.ApiManagement.Documentation("Two", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-wiki-two",
      title: "Two",
      content: "# Two",
    });
    const wiki = pages
      ? yield* Azure.ApiManagement.ProductWiki("Wiki", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          productName: product.productName,
          documents: pages.map((page) =>
            page === "one" ? one.documentationName : two.documentationName,
          ),
        })
      : undefined;
    return { group, service, product, wiki };
  });

// Documentation pages are not available on Consumption (PUT returns an
// empty 404). A BasicV2 service bills ~$0.21/h and takes 5-15+ minutes to
// create: est. ~$0.10 and ~25 minutes per run.
// Blocked by the platform: Microsoft.ApiManagement does not serve the
// documentations and wikis routes (empty 404 / "did not have proper uri
// path format") on Developer, BasicV2 or Premium services at any
// api-version, pinned by the probe below. Runs only with
// AZURE_TEST_APIM_WIKIS=1 once the routes ship.
test.provider.skipIf(!runExpensive || !process.env.AZURE_TEST_APIM_WIKIS)(
  "create, update, and delete a product wiki",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program(["one"]));
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      const product = first.product.productName;
      expect(first.wiki?.documents).toEqual(["alchemy-wiki-one"]);
      expect(
        (yield* getWiki(rg, svc, product)).properties?.documents?.map(
          (doc) => doc.documentationId,
        ),
      ).toEqual(["alchemy-wiki-one"]);

      // In-place update of the page list.
      const updated = yield* stack.deploy(program(["two", "one"]));
      expect(updated.wiki?.documents).toEqual([
        "alchemy-wiki-two",
        "alchemy-wiki-one",
      ]);

      // Removing the resource deletes the wiki.
      yield* stack.deploy(program());
      expect(yield* untilGone(getWiki(rg, svc, product))).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Probe (BasicV2, est. ~$0.05 and ~10 minutes; Consumption answers every
// documentation/wiki route with an empty 404 instead): the product
// wiki route is not served.
test.provider.skipIf(!runExpensive)(
  "product wiki PUT is rejected as an unsupported route",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group, service, product } = yield* stack.deploy(
        Effect.gen(function* () {
          const { group, service } = yield* basicV2Service;
          const product = yield* Azure.ApiManagement.Product("Starter", {
            resourceGroup: group.resourceGroupName,
            serviceName: service.serviceName,
            name: "alchemy-wiki-product",
            displayName: "Wiki product",
          });
          return { group, service, product };
        }),
      );
      const sub = yield* subscriptionId;
      const error = yield* apim
        .ProductWikiCreateOrUpdate({
          subscriptionId: sub,
          resourceGroupName: group.resourceGroupName,
          serviceName: service.serviceName,
          productId: product.productName,
          properties: { documents: [] },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("ApiManagementRouteNotSupported");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 1_800_000 },
);
