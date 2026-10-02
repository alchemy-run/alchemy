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

const getTag = (
  resourceGroupName: string,
  serviceName: string,
  tagId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetTag({ subscriptionId, resourceGroupName, serviceName, tagId }),
  );

const program = (tag?: { name: string; displayName: string }) =>
  Effect.gen(function* () {
    const { group, service } = yield* consumptionService;
    const created = tag
      ? yield* Azure.ApiManagement.Tag("Public", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          name: tag.name,
          displayName: tag.displayName,
        })
      : undefined;
    return { group, service, tag: created };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "create, update, replace, and delete a tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({ name: "alchemy-public", displayName: "Public" }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.tag?.tagName).toEqual("alchemy-public");
      expect(
        (yield* getTag(rg, svc, "alchemy-public")).properties?.displayName,
      ).toEqual("Public");

      // In-place update of the display name.
      yield* stack.deploy(
        program({ name: "alchemy-public", displayName: "Public APIs" }),
      );
      expect(
        (yield* getTag(rg, svc, "alchemy-public")).properties?.displayName,
      ).toEqual("Public APIs");

      // Replacement: a new identifier creates a new tag, deletes the old.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-public-v2", displayName: "Public v2" }),
      );
      expect(replaced.tag?.tagName).toEqual("alchemy-public-v2");
      expect(yield* untilGone(getTag(rg, svc, "alchemy-public"))).toEqual(
        "gone",
      );

      // Removing the resource deletes the tag.
      yield* stack.deploy(program());
      expect(yield* untilGone(getTag(rg, svc, "alchemy-public-v2"))).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
