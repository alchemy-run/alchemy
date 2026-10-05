import * as Azure from "@/Azure";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as maintenance from "@distilled.cloud/azure/maintenance";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getAssignment = (
  resourceGroupName: string,
  configurationAssignmentName: string,
) =>
  Effect.gen(function* () {
    return yield* maintenance.GetConfigurationAssignmentsForResourceGroup({
      subscriptionId: yield* subscription,
      resourceGroupName,
      configurationAssignmentName,
    });
  });

const program = (props: {
  config: "First" | "Second";
  osTypes: string[];
  tagValues: string[];
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const configProps = {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      maintenanceScope: "InGuestPatch" as const,
      extensionProperties: { InGuestPatchMode: "User" },
      maintenanceWindow: {
        startDateTime: "2030-01-01 02:00",
        duration: "03:55",
        timeZone: "UTC",
        recurEvery: "Day",
      },
      installPatches: {
        rebootSetting: "IfRequired" as const,
        linuxParameters: { classificationsToInclude: ["Critical", "Security"] },
      },
    };
    // Both configurations stay deployed across the replacement step.
    const first = yield* Azure.Maintenance.MaintenanceConfiguration(
      "First",
      configProps,
    );
    const second = yield* Azure.Maintenance.MaintenanceConfiguration(
      "Second",
      configProps,
    );
    const config = props.config === "First" ? first : second;
    const assignment = yield* Azure.Maintenance.ConfigurationAssignment(
      "Assignment",
      {
        scope: group.resourceGroupId,
        maintenanceConfigurationId: config.maintenanceConfigurationId,
        filter: {
          resourceTypes: ["Microsoft.Compute/virtualMachines"],
          osTypes: props.osTypes,
          tagSettings: {
            tags: { patch: props.tagValues },
            filterOperator: "Any",
          },
        },
      },
    );
    return { group, config, assignment };
  });

// Free: a dynamic-scope assignment on a resource group needs no VM (~1 min).
test.provider(
  "create, update, replace, and delete a resource-group configuration assignment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, config, assignment } = yield* stack.deploy(
        program({ config: "First", osTypes: ["Linux"], tagValues: ["nightly"] }),
      );
      const get = (name: string) =>
        getAssignment(group.resourceGroupName, name);
      expect(assignment.scope).toEqual(group.resourceGroupId);
      expect(assignment.location).toEqual("eastus");
      const observed = yield* get(assignment.configurationAssignmentName);
      expect(
        observed.properties?.maintenanceConfigurationId?.toLowerCase(),
      ).toEqual(config.maintenanceConfigurationId.toLowerCase());
      expect(observed.properties?.filter?.osTypes).toEqual(["Linux"]);
      expect(observed.properties?.filter?.tagSettings?.tags?.patch).toEqual([
        "nightly",
      ]);

      // In-place: change the dynamic-scope filter.
      const updated = yield* stack.deploy(
        program({
          config: "First",
          osTypes: ["Linux", "Windows"],
          tagValues: ["nightly", "weekly"],
        }),
      );
      expect(updated.assignment.configurationAssignmentId).toEqual(
        assignment.configurationAssignmentId,
      );
      const reobserved = yield* get(assignment.configurationAssignmentName);
      expect([...(reobserved.properties?.filter?.osTypes ?? [])].sort()).toEqual(
        ["Linux", "Windows"],
      );
      expect(
        [...(reobserved.properties?.filter?.tagSettings?.tags?.patch ?? [])].sort(),
      ).toEqual(["nightly", "weekly"]);

      // Replacement: the assigned configuration is immutable.
      const replaced = yield* stack.deploy(
        program({
          config: "Second",
          osTypes: ["Linux", "Windows"],
          tagValues: ["nightly", "weekly"],
        }),
      );
      const replacedObserved = yield* get(
        replaced.assignment.configurationAssignmentName,
      );
      expect(
        replacedObserved.properties?.maintenanceConfigurationId?.toLowerCase(),
      ).toEqual(replaced.config.maintenanceConfigurationId.toLowerCase());
      expect(replaced.config.maintenanceConfigurationId).not.toEqual(
        config.maintenanceConfigurationId,
      );
      expect(replaced.assignment.configurationAssignmentName).not.toEqual(
        assignment.configurationAssignmentName,
      );
      expect(
        yield* waitGone(get(assignment.configurationAssignmentName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(get(replaced.assignment.configurationAssignmentName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);

// Free: a subscription dynamic scope whose tag filter matches no resource.
test.provider(
  "create and delete a subscription configuration assignment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;

      const { assignment, config } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          const config = yield* Azure.Maintenance.MaintenanceConfiguration(
            "Config",
            {
              resourceGroup: group.resourceGroupName,
              location: "eastus",
              maintenanceScope: "InGuestPatch",
              extensionProperties: { InGuestPatchMode: "User" },
              maintenanceWindow: {
                startDateTime: "2030-01-01 02:00",
                duration: "03:55",
                timeZone: "UTC",
                recurEvery: "Day",
              },
              installPatches: {
                rebootSetting: "Never",
                linuxParameters: {
                  classificationsToInclude: ["Critical", "Security"],
                },
              },
            },
          );
          const assignment = yield* Azure.Maintenance.ConfigurationAssignment(
            "Assignment",
            {
              scope: `/subscriptions/${subscriptionId}`,
              maintenanceConfigurationId: config.maintenanceConfigurationId,
              filter: {
                resourceTypes: ["Microsoft.Compute/virtualMachines"],
                tagSettings: {
                  tags: { "alchemy-maintenance-test": ["never-matches"] },
                  filterOperator: "All",
                },
              },
            },
          );
          return { assignment, config };
        }),
      );
      const get = (configurationAssignmentName: string) =>
        maintenance.GetConfigurationAssignmentsForSubscription({
          subscriptionId,
          configurationAssignmentName,
        });
      expect(assignment.location).toEqual("global");
      const observed = yield* get(assignment.configurationAssignmentName);
      expect(
        observed.properties?.maintenanceConfigurationId?.toLowerCase(),
      ).toEqual(config.maintenanceConfigurationId.toLowerCase());

      // `list` (used by nuke) finds it through Resource Graph, which ingests
      // new assignments with a short delay and reports names lowercased.
      const provider = yield* Provider.findProvider(
        Azure.Maintenance.ConfigurationAssignment,
      );
      const listed = yield* provider.list().pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (all) =>
            all.some(
              (a) =>
                a.configurationAssignmentName.toLowerCase() ===
                assignment.configurationAssignmentName.toLowerCase(),
            ),
          times: 24,
        }),
      );
      const found = listed.find(
        (a) =>
          a.configurationAssignmentName.toLowerCase() ===
          assignment.configurationAssignmentName.toLowerCase(),
      );
      expect(found?.scope.toLowerCase()).toEqual(
        `/subscriptions/${subscriptionId}`.toLowerCase(),
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(get(assignment.configurationAssignmentName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
