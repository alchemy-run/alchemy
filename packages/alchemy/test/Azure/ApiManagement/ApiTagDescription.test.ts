import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  consumptionApi,
  logLevel,
  subscriptionId,
  tags,
  untilGone,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getDescription = (
  resourceGroupName: string,
  serviceName: string,
  apiId: string,
  tagDescriptionId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetApiTagDescription({
      subscriptionId,
      resourceGroupName,
      serviceName,
      apiId,
      tagDescriptionId,
    }),
  );

const program = (description?: { tag: "one" | "two"; text: string }) =>
  Effect.gen(function* () {
    const { group, service, api } = yield* consumptionApi;
    // Both tags stay deployed across the replacement step.
    const one = yield* Azure.ApiManagement.Tag("One", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-desc-one",
    });
    const two = yield* Azure.ApiManagement.Tag("Two", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-desc-two",
    });
    const created = description
      ? yield* Azure.ApiManagement.ApiTagDescription("Docs", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          apiName: api.apiName,
          tagName: description.tag === "one" ? one.tagName : two.tagName,
          description: description.text,
          externalDocsUrl: "https://example.com/docs",
          externalDocsDescription: "Guide",
        })
      : undefined;
    return { group, service, api, description: created };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "create, update, replace, and delete an API tag description",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program({ tag: "one", text: "First" }));
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      const api = first.api.apiName;
      expect(first.description?.tagName).toEqual("alchemy-desc-one");
      const observed = yield* getDescription(rg, svc, api, "alchemy-desc-one");
      expect(observed.properties?.description).toEqual("First");
      expect(observed.properties?.externalDocsUrl).toEqual(
        "https://example.com/docs",
      );

      // In-place update of the description.
      yield* stack.deploy(program({ tag: "one", text: "Second" }));
      expect(
        (yield* getDescription(rg, svc, api, "alchemy-desc-one")).properties
          ?.description,
      ).toEqual("Second");

      // Replacement: describing another tag deletes the old description.
      const replaced = yield* stack.deploy(
        program({ tag: "two", text: "Second" }),
      );
      expect(replaced.description?.tagName).toEqual("alchemy-desc-two");
      expect(
        yield* untilGone(getDescription(rg, svc, api, "alchemy-desc-one")),
      ).toEqual("gone");

      // Removing the resource deletes the description.
      yield* stack.deploy(program());
      expect(
        yield* untilGone(getDescription(rg, svc, api, "alchemy-desc-two")),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
