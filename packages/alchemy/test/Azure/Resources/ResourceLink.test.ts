import * as Azure from "@/Azure";
import { orUndefinedIfNotFound } from "@/Azure/Arm.ts";
import * as Test from "@/Test/Alchemy";
import * as resources from "@distilled.cloud/azure/resources";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getLink = (linkId: string) =>
  orUndefinedIfNotFound(
    resources.GetResourceLink({ linkId: linkId.replace(/^\/+/, "") }),
  );

const linkGone = (linkId: string) =>
  getLink(linkId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (observed) => observed === undefined,
      times: 10,
    }),
  );

const program = (target: "B" | "C", notes: string) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const a = yield* Azure.ManagedIdentity.UserAssignedIdentity("A", {
      resourceGroup: group.resourceGroupName,
    });
    const b = yield* Azure.ManagedIdentity.UserAssignedIdentity("B", {
      resourceGroup: group.resourceGroupName,
    });
    const c = yield* Azure.ManagedIdentity.UserAssignedIdentity("C", {
      resourceGroup: group.resourceGroupName,
    });
    const link = yield* Azure.Resources.ResourceLink("Link", {
      sourceId: a.identityId,
      targetId: target === "B" ? b.identityId : c.identityId,
      notes,
    });
    return { group, a, b, c, link };
  });

test.provider(
  "link two resources, retarget the link, and delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { a, b, c, link } = yield* stack.deploy(program("B", "uses b"));
      expect(link.sourceId.toLowerCase()).toEqual(a.identityId.toLowerCase());
      expect(link.targetId.toLowerCase()).toEqual(b.identityId.toLowerCase());
      expect(link.notes).toEqual("uses b");
      const observed = yield* getLink(link.linkId);
      expect(observed?.properties?.notes).toMatch(
        /^uses b \[alchemy .+\/Link\]$/,
      );

      // Notes are mutable in place.
      const updated = yield* stack.deploy(program("B", "still uses b"));
      expect(updated.link.linkId).toEqual(link.linkId);
      expect(updated.link.notes).toEqual("still uses b");
      const reobserved = yield* getLink(link.linkId);
      expect(reobserved?.properties?.notes).toMatch(/^still uses b \[alchemy /);

      // ARM cannot retarget a link: a new target replaces it.
      const retargeted = yield* stack.deploy(program("C", "uses c"));
      expect(retargeted.link.linkId).not.toEqual(link.linkId);
      expect(retargeted.link.targetId.toLowerCase()).toEqual(
        c.identityId.toLowerCase(),
      );
      const replaced = yield* getLink(retargeted.link.linkId);
      expect(
        replaced?.properties?.targetId?.replace(/\/+$/, "").toLowerCase(),
      ).toEqual(c.identityId.toLowerCase());
      expect(yield* linkGone(link.linkId)).toBeUndefined();

      yield* stack.destroy();
      expect(yield* linkGone(retargeted.link.linkId)).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:resources", "live"],
    timeout: 600_000,
  },
);
