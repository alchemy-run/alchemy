import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as devcenter from "@distilled.cloud/azure/devcenter";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getProjectEnvironmentType = (
  resourceGroupName: string,
  projectName: string,
  environmentTypeName: string,
) =>
  Effect.gen(function* () {
    return yield* devcenter.GetProjectEnvironmentType({
      subscriptionId: yield* subscription,
      resourceGroupName,
      projectName,
      environmentTypeName,
    });
  });

const program = (props: {
  environmentType: "dev" | "test";
  status: "Enabled" | "Disabled";
  displayName: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const subscriptionId = yield* subscription;
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const center = yield* Azure.DevCenter.DevCenter("Center", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
    });
    const project = yield* Azure.DevCenter.Project("Project", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      devCenterId: center.devCenterId,
    });
    // Both dev center environment types stay deployed across the
    // replacement step below.
    const dev = yield* Azure.DevCenter.EnvironmentType("Dev", {
      resourceGroup: group.resourceGroupName,
      devCenter: center.devCenterName,
      name: "dev",
    });
    const testType = yield* Azure.DevCenter.EnvironmentType("Test", {
      resourceGroup: group.resourceGroupName,
      devCenter: center.devCenterName,
      name: "test",
    });
    const projectEnvironmentType = yield* Azure.DevCenter.ProjectEnvironmentType(
      "ProjectEnvironmentType",
      {
        resourceGroup: group.resourceGroupName,
        project: project.projectName,
        environmentType:
          props.environmentType === "dev"
            ? dev.environmentTypeName
            : testType.environmentTypeName,
        location: "eastus",
        deploymentTargetId: `/subscriptions/${subscriptionId}`,
        status: props.status,
        displayName: props.displayName,
        // Reader for environment creators.
        creatorRoles: [Azure.Authorization.BuiltInRole.Reader],
        tags: props.tags,
      },
    );
    return { group, project, projectEnvironmentType };
  });

// Dev centers, projects, and environment types are free; ~10 minutes in
// total (the dev center create and delete dominate), $0.
test.provider(
  "create, update, replace, and delete a project environment type",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;

      const { group, project, projectEnvironmentType } = yield* stack.deploy(
        program({
          environmentType: "dev",
          status: "Enabled",
          displayName: "One",
          tags: { a: "1" },
        }),
      );
      expect(projectEnvironmentType.environmentTypeName).toEqual("dev");
      expect(projectEnvironmentType.status).toEqual("Enabled");
      const observed = yield* getProjectEnvironmentType(
        group.resourceGroupName,
        project.projectName,
        "dev",
      );
      expect(observed.id).toEqual(
        projectEnvironmentType.projectEnvironmentTypeId,
      );
      expect(observed.properties?.deploymentTargetId?.toLowerCase()).toEqual(
        `/subscriptions/${subscriptionId}`.toLowerCase(),
      );
      expect(observed.properties?.displayName).toEqual("One");
      expect(
        Object.keys(observed.properties?.creatorRoleAssignment?.roles ?? {}),
      ).toEqual([Azure.Authorization.BuiltInRole.Reader]);
      expect(observed.tags?.a).toEqual("1");
      expect(observed.tags?.["alchemy::id"]).toEqual("ProjectEnvironmentType");

      // In place: status, display name, and tags.
      const updated = yield* stack.deploy(
        program({
          environmentType: "dev",
          status: "Disabled",
          displayName: "Two",
          tags: { a: "2" },
        }),
      );
      expect(updated.projectEnvironmentType.projectEnvironmentTypeId).toEqual(
        projectEnvironmentType.projectEnvironmentTypeId,
      );
      const reobserved = yield* getProjectEnvironmentType(
        group.resourceGroupName,
        project.projectName,
        "dev",
      );
      expect(reobserved.properties?.status).toEqual("Disabled");
      expect(reobserved.properties?.displayName).toEqual("Two");
      expect(reobserved.tags?.a).toEqual("2");

      // Replacement: the environment type is the name, so it is immutable.
      const replaced = yield* stack.deploy(
        program({
          environmentType: "test",
          status: "Disabled",
          displayName: "Two",
          tags: { a: "2" },
        }),
      );
      expect(replaced.projectEnvironmentType.environmentTypeName).toEqual(
        "test",
      );
      expect(
        yield* waitGone(
          getProjectEnvironmentType(
            group.resourceGroupName,
            project.projectName,
            "dev",
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getProjectEnvironmentType(
            group.resourceGroupName,
            project.projectName,
            "test",
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
