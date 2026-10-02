import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import {
  developerService,
  logLevel,
  subscriptionId,
  tags,
  untilGone,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getGroup = (
  resourceGroupName: string,
  serviceName: string,
  groupId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetGroup({ subscriptionId, resourceGroupName, serviceName, groupId }),
  );

const program = (group?: { name: string; displayName: string }) =>
  Effect.gen(function* () {
    const { group: rg, service } = yield* developerService;
    const created = group
      ? yield* Azure.ApiManagement.Group("Partners", {
          resourceGroup: rg.resourceGroupName,
          serviceName: service.serviceName,
          name: group.name,
          displayName: group.displayName,
          description: "Partner developers",
        })
      : undefined;
    return { group: rg, service, apimGroup: created };
  });

// Groups are not available on Consumption. A Developer service costs
// ~$0.07/h but takes 30-45 min to create (plus ~15 min to delete), well
// past the 10-minute budget: est. ~$0.10 and ~60 minutes per run.
test.provider.skipIf(!runExpensive)(
  "create, update, replace, and delete a group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({ name: "alchemy-partners", displayName: "Partners" }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.apimGroup?.groupName).toEqual("alchemy-partners");
      expect(first.apimGroup?.type).toEqual("custom");
      const observed = yield* getGroup(rg, svc, "alchemy-partners");
      expect(observed.properties?.displayName).toEqual("Partners");
      expect(observed.properties?.description).toEqual("Partner developers");

      // In-place update of the display name.
      yield* stack.deploy(
        program({ name: "alchemy-partners", displayName: "Partners Plus" }),
      );
      expect(
        (yield* getGroup(rg, svc, "alchemy-partners")).properties?.displayName,
      ).toEqual("Partners Plus");

      // Replacement: a new identifier creates a new group and deletes the old.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-partners-v2", displayName: "Partners v2" }),
      );
      expect(replaced.apimGroup?.groupName).toEqual("alchemy-partners-v2");
      expect(yield* untilGone(getGroup(rg, svc, "alchemy-partners"))).toEqual(
        "gone",
      );

      // Removing the resource deletes the group.
      yield* stack.deploy(program());
      expect(
        yield* untilGone(getGroup(rg, svc, "alchemy-partners-v2")),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 3_600_000 },
);
