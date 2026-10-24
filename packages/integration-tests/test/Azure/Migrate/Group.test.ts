import * as Azure from "@alchemy.run/azure";
import * as migrate from "@distilled.cloud/azure/migrate";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (groupType?: "Default" | "Import") =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const project = yield* Azure.Migrate.AssessmentProject("Project", {
      resourceGroup: group.resourceGroupName,
      location,
    });
    const machines = yield* Azure.Migrate.Group("Machines", {
      resourceGroup: group.resourceGroupName,
      assessmentProject: project.projectName,
      groupType,
    });
    return { group, project, machines };
  });

const getGroup = (resourceGroupName: string, projectName: string, groupName: string) =>
  Effect.gen(function* () {
    return yield* migrate.GetGroupsOperation({
      subscriptionId: yield* subscription,
      resourceGroupName,
      projectName,
      groupName,
    });
  });

// Free control-plane objects; under a minute. A group has no mutable
// settings (membership is the `updateMachines` action), so the lifecycle is
// create, a no-op redeploy, and replacement.
test.provider(
  "create, redeploy, replace, and delete an assessment group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, project, machines } = yield* stack.deploy(program());
      const get = (name: string) => getGroup(group.resourceGroupName, project.projectName, name);
      expect(machines.groupType).toEqual("Default");
      expect(machines.machineCount).toEqual(0);
      expect(machines.groupId.toLowerCase()).toContain(
        `/assessmentprojects/${project.projectName.toLowerCase()}/groups/${machines.groupName.toLowerCase()}`,
      );
      const observed = yield* get(machines.groupName);
      expect(observed.properties?.groupType).toEqual("Default");

      // Redeploying the same props keeps the group.
      const same = yield* stack.deploy(program("Default"));
      expect(same.machines.groupId).toEqual(machines.groupId);

      // Replacement: the group type is immutable.
      const replaced = yield* stack.deploy(program("Import"));
      expect(replaced.machines.groupName).not.toEqual(machines.groupName);
      expect(replaced.machines.groupType).toEqual("Import");
      const imported = yield* get(replaced.machines.groupName);
      expect(imported.properties?.groupType).toEqual("Import");
      expect(yield* waitGone(get(machines.groupName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.machines.groupName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
