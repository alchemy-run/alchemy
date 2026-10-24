import * as Azure from "@alchemy.run/azure";
import * as devcenter from "@distilled.cloud/azure/devcenter";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getProject = (resourceGroupName: string, projectName: string) =>
  Effect.gen(function* () {
    return yield* devcenter.GetProject({
      subscriptionId: yield* subscription,
      resourceGroupName,
      projectName,
    });
  });

const program = (props: {
  name?: string;
  description: string;
  displayName: string;
  maxDevBoxesPerUser: number;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
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
      name: props.name,
      description: props.description,
      displayName: props.displayName,
      maxDevBoxesPerUser: props.maxDevBoxesPerUser,
      tags: props.tags,
    });
    return { group, center, project };
  });

// Dev centers and projects are free ($0); ~10 minutes in total (the dev
// center create and delete dominate).
test.provider(
  "create, update, replace, and delete a dev center project",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, center, project } = yield* stack.deploy(
        program({
          description: "One",
          displayName: "Project One",
          maxDevBoxesPerUser: 1,
          tags: { a: "1" },
        }),
      );
      expect(project.devCenterId.toLowerCase()).toEqual(center.devCenterId.toLowerCase());
      expect(project.description).toEqual("One");
      expect(project.maxDevBoxesPerUser).toEqual(1);
      expect(project.tags).toEqual({ a: "1" });
      const observed = yield* getProject(group.resourceGroupName, project.projectName);
      expect(observed.id).toEqual(project.projectId);
      expect(observed.properties?.devCenterId?.toLowerCase()).toEqual(
        center.devCenterId.toLowerCase(),
      );
      expect(observed.properties?.description).toEqual("One");
      expect(observed.properties?.displayName).toEqual("Project One");
      expect(observed.properties?.maxDevBoxesPerUser).toEqual(1);
      expect(observed.tags?.a).toEqual("1");
      expect(observed.tags?.["alchemy::id"]).toEqual("Project");

      // In place: description, display name, limit, and tags.
      const updated = yield* stack.deploy(
        program({
          description: "Two",
          displayName: "Project Two",
          maxDevBoxesPerUser: 3,
          tags: { a: "2" },
        }),
      );
      expect(updated.project.projectId).toEqual(project.projectId);
      const reobserved = yield* getProject(group.resourceGroupName, project.projectName);
      expect(reobserved.properties?.description).toEqual("Two");
      expect(reobserved.properties?.displayName).toEqual("Project Two");
      expect(reobserved.properties?.maxDevBoxesPerUser).toEqual(3);
      expect(reobserved.tags?.a).toEqual("2");

      // Replacement: the name is immutable.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-project-renamed",
          description: "Two",
          displayName: "Project Two",
          maxDevBoxesPerUser: 3,
          tags: { a: "2" },
        }),
      );
      expect(replaced.project.projectName).toEqual("alchemy-project-renamed");
      expect(replaced.project.projectId).not.toEqual(project.projectId);
      const renamed = yield* getProject(group.resourceGroupName, "alchemy-project-renamed");
      expect(renamed.properties?.description).toEqual("Two");
      expect(
        yield* waitGone(getProject(group.resourceGroupName, project.projectName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(getProject(group.resourceGroupName, "alchemy-project-renamed")),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 1_800_000 },
);
