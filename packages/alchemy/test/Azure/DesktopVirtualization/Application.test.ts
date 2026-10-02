import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as desktopvirtualization from "@distilled.cloud/azure/desktopvirtualization";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getApplication = (
  resourceGroupName: string,
  applicationGroupName: string,
  applicationName: string,
) =>
  Effect.gen(function* () {
    return yield* desktopvirtualization.GetApplication({
      subscriptionId: yield* subscription,
      resourceGroupName,
      applicationGroupName,
      applicationName,
    });
  });

const program = (props: {
  name?: string;
  friendlyName: string;
  commandLineSetting: "DoNotAllow" | "Allow" | "Require";
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const pool = yield* Azure.DesktopVirtualization.HostPool("Pool", {
      resourceGroup: group.resourceGroupName,
      location,
      hostPoolType: "Pooled",
      loadBalancerType: "BreadthFirst",
      preferredAppGroupType: "RailApplications",
    });
    const apps = yield* Azure.DesktopVirtualization.ApplicationGroup("Apps", {
      resourceGroup: group.resourceGroupName,
      location,
      hostPoolId: pool.hostPoolId,
      applicationGroupType: "RemoteApp",
    });
    const app = yield* Azure.DesktopVirtualization.Application("Notepad", {
      resourceGroup: group.resourceGroupName,
      applicationGroup: apps.applicationGroupName,
      name: props.name,
      filePath: "C:\\Windows\\System32\\notepad.exe",
      friendlyName: props.friendlyName,
      commandLineSetting: props.commandLineSetting,
      showInPortal: true,
    });
    return { group, apps, app };
  });

// Applications are free metadata objects; no session host is needed.
test.provider(
  "create, update, replace, and delete a RemoteApp application",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, apps, app } = yield* stack.deploy(
        program({ friendlyName: "Notepad", commandLineSetting: "DoNotAllow" }),
      );
      const rg = group.resourceGroupName;
      const get = (name: string) =>
        getApplication(rg, apps.applicationGroupName, name);
      const observed = yield* get(app.applicationName);
      expect(observed.properties.filePath).toEqual(
        "C:\\Windows\\System32\\notepad.exe",
      );
      expect(observed.properties.friendlyName).toEqual("Notepad");
      expect(observed.properties.commandLineSetting).toEqual("DoNotAllow");

      // In place: display name and command line setting.
      const updated = yield* stack.deploy(
        program({ friendlyName: "Editor", commandLineSetting: "Allow" }),
      );
      expect(updated.app.applicationId).toEqual(app.applicationId);
      const reobserved = yield* get(app.applicationName);
      expect(reobserved.properties.friendlyName).toEqual("Editor");
      expect(reobserved.properties.commandLineSetting).toEqual("Allow");

      // Replacement: the application name is immutable.
      const replaced = yield* stack.deploy(
        program({
          name: "notepad-app",
          friendlyName: "Editor",
          commandLineSetting: "Allow",
        }),
      );
      expect(replaced.app.applicationName).toEqual("notepad-app");
      expect((yield* get("notepad-app")).properties.friendlyName).toEqual(
        "Editor",
      );
      expect(yield* waitGone(get(app.applicationName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("notepad-app"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
