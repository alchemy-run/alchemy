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

const getLink = (
  resourceGroupName: string,
  serviceName: string,
  apiId: string,
  tagId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetTagByOperation({
      subscriptionId,
      resourceGroupName,
      serviceName,
      apiId,
      operationId: "greet",
      tagId,
    }),
  );

const program = (tag?: "one" | "two") =>
  Effect.gen(function* () {
    const { group, service, api } = yield* consumptionApi;
    // Both tags stay deployed across the replacement step.
    const one = yield* Azure.ApiManagement.Tag("One", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-tag-one",
    });
    const two = yield* Azure.ApiManagement.Tag("Two", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-tag-two",
    });
    const operation = yield* Azure.ApiManagement.ApiOperation("Greet", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      apiName: api.apiName,
      name: "greet",
      displayName: "Greet",
      method: "GET",
      urlTemplate: "/greet",
    });
    const link = tag
      ? yield* Azure.ApiManagement.ApiOperationTagLink("Link", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          apiName: api.apiName,
          operationName: operation.operationName,
          tagName: tag === "one" ? one.tagName : two.tagName,
        })
      : undefined;
    return { group, service, api, link };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "assign, replace, and detach a tag on an API operation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program("one"));
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      const api = first.api.apiName;
      expect(first.link?.tagName).toEqual("alchemy-tag-one");
      expect(first.link?.linkId).toContain(
        "/operations/greet/tags/alchemy-tag-one",
      );
      expect((yield* getLink(rg, svc, api, "alchemy-tag-one")).name).toEqual(
        "alchemy-tag-one",
      );

      // Replacement: a different tag assigns the new one, detaches the old.
      const replaced = yield* stack.deploy(program("two"));
      expect(replaced.link?.tagName).toEqual("alchemy-tag-two");
      expect((yield* getLink(rg, svc, api, "alchemy-tag-two")).name).toEqual(
        "alchemy-tag-two",
      );
      expect(
        yield* untilGone(getLink(rg, svc, api, "alchemy-tag-one")),
      ).toEqual("gone");

      // Removing the resource detaches the tag.
      yield* stack.deploy(program());
      expect(
        yield* untilGone(getLink(rg, svc, api, "alchemy-tag-two")),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
