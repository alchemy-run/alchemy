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

const getLink = (resourceGroupName: string, rmplName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* orUndefinedIfNotFound(
      resources.GetResourceManagementPrivateLink({
        subscriptionId,
        resourceGroupName,
        rmplName,
      }),
    );
  });

const linkGone = (resourceGroupName: string, rmplName: string) =>
  getLink(resourceGroupName, rmplName).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (observed) => observed === undefined,
      times: 20,
    }),
  );

const program = (location: string) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const link = yield* Azure.Resources.ResourceManagementPrivateLink("Link", {
      resourceGroup: group.resourceGroupName,
      location,
    });
    return { group, link };
  });

// Free; no mutable settings, so the lifecycle is create → replace → delete.
test.provider(
  "create a resource management private link, replace it on a location change, and delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, link } = yield* stack.deploy(program("eastus"));
      expect(link.location.toLowerCase()).toEqual("eastus");
      expect(link.privateEndpointConnections).toEqual([]);
      const observed = yield* getLink(
        group.resourceGroupName,
        link.resourceManagementPrivateLinkName,
      );
      expect(observed?.id?.toLowerCase()).toEqual(
        link.resourceManagementPrivateLinkId.toLowerCase(),
      );

      // Redeploying unchanged is a no-op.
      const again = yield* stack.deploy(program("eastus"));
      expect(again.link.resourceManagementPrivateLinkId).toEqual(
        link.resourceManagementPrivateLinkId,
      );

      // A new location replaces the link.
      const moved = yield* stack.deploy(program("westus2"));
      expect(moved.link.location.toLowerCase()).toEqual("westus2");
      expect(moved.link.resourceManagementPrivateLinkName).not.toEqual(
        link.resourceManagementPrivateLinkName,
      );
      expect(
        yield* linkGone(
          group.resourceGroupName,
          link.resourceManagementPrivateLinkName,
        ),
      ).toBeUndefined();

      yield* stack.destroy();
      expect(
        yield* linkGone(
          group.resourceGroupName,
          moved.link.resourceManagementPrivateLinkName,
        ),
      ).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:resources", "live"],
    timeout: 600_000,
  },
);
