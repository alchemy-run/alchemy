import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as desktopvirtualization from "@distilled.cloud/azure/desktopvirtualization";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getApplicationGroup = (
  resourceGroupName: string,
  applicationGroupName: string,
) =>
  Effect.gen(function* () {
    return yield* desktopvirtualization.GetApplicationGroup({
      subscriptionId: yield* subscription,
      resourceGroupName,
      applicationGroupName,
    });
  });

const program = (props: {
  applicationGroupType: Azure.DesktopVirtualization.ApplicationGroupType;
  friendlyName: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const pool = yield* Azure.DesktopVirtualization.HostPool("Pool", {
      resourceGroup: group.resourceGroupName,
      location,
      hostPoolType: "Pooled",
      loadBalancerType: "BreadthFirst",
    });
    const appGroup = yield* Azure.DesktopVirtualization.ApplicationGroup(
      "AppGroup",
      {
        resourceGroup: group.resourceGroupName,
        location,
        hostPoolId: pool.hostPoolId,
        ...props,
      },
    );
    return { group, pool, appGroup };
  });

// Host pools and application groups are free metadata objects.
test.provider(
  "create, update, replace, and delete an application group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, pool, appGroup } = yield* stack.deploy(
        program({
          applicationGroupType: "Desktop",
          friendlyName: "Desktops v1",
          tags: { env: "test" },
        }),
      );
      const rg = group.resourceGroupName;
      expect(appGroup.hostPoolId.toLowerCase()).toEqual(
        pool.hostPoolId.toLowerCase(),
      );
      const observed = yield* getApplicationGroup(
        rg,
        appGroup.applicationGroupName,
      );
      expect(observed.properties.applicationGroupType).toEqual("Desktop");
      expect(observed.properties.friendlyName).toEqual("Desktops v1");
      expect(observed.tags?.env).toEqual("test");

      // In place: friendly name and tags.
      const updated = yield* stack.deploy(
        program({
          applicationGroupType: "Desktop",
          friendlyName: "Desktops v2",
          tags: { env: "prod" },
        }),
      );
      expect(updated.appGroup.applicationGroupId).toEqual(
        appGroup.applicationGroupId,
      );
      const reobserved = yield* getApplicationGroup(
        rg,
        appGroup.applicationGroupName,
      );
      expect(reobserved.properties.friendlyName).toEqual("Desktops v2");
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: the application group type is immutable.
      const replaced = yield* stack.deploy(
        program({
          applicationGroupType: "RemoteApp",
          friendlyName: "Apps",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.appGroup.applicationGroupName).not.toEqual(
        appGroup.applicationGroupName,
      );
      const remoteApp = yield* getApplicationGroup(
        rg,
        replaced.appGroup.applicationGroupName,
      );
      expect(remoteApp.properties.applicationGroupType).toEqual("RemoteApp");
      expect(
        yield* waitGone(getApplicationGroup(rg, appGroup.applicationGroupName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getApplicationGroup(rg, replaced.appGroup.applicationGroupName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
