import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as desktopvirtualization from "@distilled.cloud/azure/desktopvirtualization";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getWorkspace = (resourceGroupName: string, workspaceName: string) =>
  Effect.gen(function* () {
    return yield* desktopvirtualization.GetWorkspace({
      subscriptionId: yield* subscription,
      resourceGroupName,
      workspaceName,
    });
  });

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
  publish: boolean;
  friendlyName: string;
  name?: string;
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
      "Desktops",
      {
        resourceGroup: group.resourceGroupName,
        location,
        hostPoolId: pool.hostPoolId,
        applicationGroupType: "Desktop",
      },
    );
    const workspace = yield* Azure.DesktopVirtualization.Workspace("Feed", {
      resourceGroup: group.resourceGroupName,
      location,
      name: props.name,
      friendlyName: props.friendlyName,
      applicationGroupIds: props.publish ? [appGroup.applicationGroupId] : [],
      tags: { env: "test" },
    });
    return { group, appGroup, workspace };
  });

// Workspaces are free metadata objects.
test.provider(
  "create, update, replace, and delete a workspace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, appGroup, workspace } = yield* stack.deploy(
        program({ publish: true, friendlyName: "Feed v1" }),
      );
      const rg = group.resourceGroupName;
      const observed = yield* getWorkspace(rg, workspace.workspaceName);
      expect(observed.properties?.friendlyName).toEqual("Feed v1");
      expect(
        observed.properties?.applicationGroupReferences?.map((id) =>
          id.toLowerCase(),
        ),
      ).toEqual([appGroup.applicationGroupId.toLowerCase()]);
      const published = yield* getApplicationGroup(
        rg,
        appGroup.applicationGroupName,
      );
      expect(published.properties.workspaceArmPath?.toLowerCase()).toEqual(
        workspace.workspaceId.toLowerCase(),
      );

      // In place: unpublish the group and rename the feed.
      const updated = yield* stack.deploy(
        program({ publish: false, friendlyName: "Feed v2" }),
      );
      expect(updated.workspace.workspaceId).toEqual(workspace.workspaceId);
      const reobserved = yield* getWorkspace(rg, workspace.workspaceName);
      expect(reobserved.properties?.friendlyName).toEqual("Feed v2");
      expect(reobserved.properties?.applicationGroupReferences ?? []).toEqual(
        [],
      );

      // Replacement: the workspace name is immutable.
      const replaced = yield* stack.deploy(
        program({
          publish: true,
          friendlyName: "Feed v3",
          name: "alchemy-avd-test-feed",
        }),
      );
      expect(replaced.workspace.workspaceName).toEqual("alchemy-avd-test-feed");
      const renamed = yield* getWorkspace(rg, "alchemy-avd-test-feed");
      expect(renamed.properties?.applicationGroupReferences?.length).toEqual(1);
      expect(
        yield* waitGone(getWorkspace(rg, workspace.workspaceName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(getWorkspace(rg, "alchemy-avd-test-feed")),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
