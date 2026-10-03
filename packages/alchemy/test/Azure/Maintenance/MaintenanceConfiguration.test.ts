import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as maintenance from "@distilled.cloud/azure/maintenance";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConfiguration = (resourceGroupName: string, resourceName: string) =>
  Effect.gen(function* () {
    return yield* maintenance.GetMaintenanceConfiguration({
      subscriptionId: yield* subscription,
      resourceGroupName,
      resourceName,
    });
  });

const program = (props: {
  recurEvery: string;
  scope: "InGuestPatch" | "Host";
  tags?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const config = yield* Azure.Maintenance.MaintenanceConfiguration(
      "Config",
      {
        resourceGroup: group.resourceGroupName,
        location: "eastus",
        maintenanceScope: props.scope,
        extensionProperties:
          props.scope === "InGuestPatch"
            ? { InGuestPatchMode: "User" }
            : undefined,
        maintenanceWindow: {
          startDateTime: "2030-01-01 02:00",
          duration: props.scope === "InGuestPatch" ? "03:55" : "05:00",
          timeZone: "UTC",
          recurEvery: props.recurEvery,
        },
        installPatches:
          props.scope === "InGuestPatch"
            ? {
                rebootSetting: "IfRequired",
                linuxParameters: {
                  classificationsToInclude: ["Critical", "Security"],
                },
              }
            : undefined,
        tags: props.tags,
      },
    );
    return { group, config };
  });

// Free: maintenance configurations are metadata only (~1 minute).
test.provider(
  "create, update, replace, and delete a maintenance configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, config } = yield* stack.deploy(
        program({
          scope: "InGuestPatch",
          recurEvery: "Day",
          tags: { env: "test" },
        }),
      );
      const get = (name: string) =>
        getConfiguration(group.resourceGroupName, name);
      expect(config.maintenanceScope).toEqual("InGuestPatch");
      const observed = yield* get(config.maintenanceConfigurationName);
      expect(observed.properties?.maintenanceWindow?.recurEvery).toEqual("Day");
      expect(observed.properties?.extensionProperties?.InGuestPatchMode).toEqual(
        "User",
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Config");

      // In-place: change the recurrence and the tags.
      const updated = yield* stack.deploy(
        program({
          scope: "InGuestPatch",
          recurEvery: "Week Saturday,Sunday",
          tags: { env: "prod" },
        }),
      );
      expect(updated.config.maintenanceConfigurationId).toEqual(
        config.maintenanceConfigurationId,
      );
      const reobserved = yield* get(config.maintenanceConfigurationName);
      expect(reobserved.properties?.maintenanceWindow?.recurEvery).toEqual(
        "Week Saturday,Sunday",
      );
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: the maintenance scope is immutable.
      const replaced = yield* stack.deploy(
        program({ scope: "Host", recurEvery: "Week Saturday,Sunday" }),
      );
      expect(replaced.config.maintenanceConfigurationName).not.toEqual(
        config.maintenanceConfigurationName,
      );
      const replacedObserved = yield* get(
        replaced.config.maintenanceConfigurationName,
      );
      expect(replacedObserved.properties?.maintenanceScope).toEqual("Host");
      expect(yield* waitGone(get(config.maintenanceConfigurationName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(get(replaced.config.maintenanceConfigurationName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
