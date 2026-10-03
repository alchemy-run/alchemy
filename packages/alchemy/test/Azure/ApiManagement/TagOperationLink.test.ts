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

const getLink = (resourceGroupName: string, serviceName: string, id: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetTagOperationLink({
      subscriptionId,
      resourceGroupName,
      serviceName,
      tagId: "alchemy-link-tag",
      operationLinkId: id,
    }),
  );

const program = (target?: "one" | "two") =>
  Effect.gen(function* () {
    const { group, service, api } = yield* consumptionApi;
    const tag = yield* Azure.ApiManagement.Tag("Tag", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-link-tag",
    });
    // Both operations stay deployed across the replacement step.
    const one = yield* Azure.ApiManagement.ApiOperation("One", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      apiName: api.apiName,
      name: "alchemy-link-one",
      displayName: "One",
      method: "GET",
      urlTemplate: "/one",
    });
    const two = yield* Azure.ApiManagement.ApiOperation("Two", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      apiName: api.apiName,
      name: "alchemy-link-two",
      displayName: "Two",
      method: "GET",
      urlTemplate: "/two",
    });
    const link = target
      ? yield* Azure.ApiManagement.TagOperationLink("Link", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          tagName: tag.tagName,
          apiName: api.apiName,
          operationName:
            target === "one" ? one.operationName : two.operationName,
          name: `link-${target}`,
        })
      : undefined;
    return { group, service, link };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "create, replace, and delete a tag operation link",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program("one"));
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.link?.operationName).toEqual("alchemy-link-one");
      const firstId = "link-one";
      expect((yield* getLink(rg, svc, firstId)).name).toEqual(firstId);

      // Replacement: another target creates the new link, deletes the old.
      const replaced = yield* stack.deploy(program("two"));
      expect(replaced.link?.operationName).toEqual("alchemy-link-two");
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
