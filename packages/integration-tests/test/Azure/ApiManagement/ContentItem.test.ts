import * as Azure from "@alchemy.run/azure";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { basicV2Service, logLevel, subscriptionId, tags, untilGone } from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getItem = (resourceGroupName: string, serviceName: string, contentItemId: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetContentItem({
      subscriptionId,
      resourceGroupName,
      serviceName,
      contentTypeId: "url",
      contentItemId,
    }),
  );

const link = (title: string) => ({
  en_us: { title, description: `${title} link`, permalink: "https://example.com/docs" },
});

const program = (item?: { name: string; title: string }) =>
  Effect.gen(function* () {
    const { group, service } = yield* basicV2Service;
    const created = item
      ? yield* Azure.ApiManagement.ContentItem("DocsLink", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          contentTypeName: "url",
          name: item.name,
          properties: link(item.title),
        })
      : undefined;
    return { group, service, item: created };
  });

// Content items belong to the developer portal, which Consumption lacks.
// A BasicV2 service bills ~$0.21/h and takes 5-15+ minutes to create:
// est. ~$0.10 and ~25 minutes per run.
test.provider.skipIf(!runExpensive)(
  "create, update, replace, and delete a content item",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program({ name: "alchemy-docs", title: "Docs" }));
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.item?.contentItemName).toEqual("alchemy-docs");
      expect(first.item?.contentTypeName).toEqual("url");
      expect((yield* getItem(rg, svc, "alchemy-docs")).properties).toMatchObject(link("Docs"));

      // In-place update of the content.
      yield* stack.deploy(program({ name: "alchemy-docs", title: "Guides" }));
      expect((yield* getItem(rg, svc, "alchemy-docs")).properties).toMatchObject(link("Guides"));

      // Replacement: a new identifier creates a new item, deletes the old.
      const replaced = yield* stack.deploy(program({ name: "alchemy-docs-v2", title: "Docs v2" }));
      expect(replaced.item?.contentItemName).toEqual("alchemy-docs-v2");
      expect(yield* untilGone(getItem(rg, svc, "alchemy-docs"))).toEqual("gone");

      // Removing the resource deletes the item.
      yield* stack.deploy(program());
      expect(yield* untilGone(getItem(rg, svc, "alchemy-docs-v2"))).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 1_800_000 },
);
