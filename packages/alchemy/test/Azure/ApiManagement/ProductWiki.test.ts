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
  apiId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetApiWiki({ subscriptionId, resourceGroupName, serviceName, apiId }),
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
test.provider.skipIf(!runExpensive)(
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
