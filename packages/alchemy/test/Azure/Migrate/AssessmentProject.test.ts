import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as migrate from "@distilled.cloud/azure/migrate";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  location: string;
  tags?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const project = yield* Azure.Migrate.AssessmentProject("Project", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      tags: props.tags,
    });
    return { group, project };
  });

const getProject = (resourceGroupName: string, projectName: string) =>
  Effect.gen(function* () {
    return yield* migrate.GetAssessmentProjectsOperation({
      subscriptionId: yield* subscription,
      resourceGroupName,
      projectName,
    });
  });

// Free control-plane object; under a minute. `projectStatus` is not
// exercised: the service ignores it on both PUT and PATCH.
test.provider(
  "create, update, replace, and delete an assessment project",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, project } = yield* stack.deploy(
        program({ location, tags: { env: "test" } }),
      );
      const get = (name: string) => getProject(group.resourceGroupName, name);
      expect(project.location).toEqual(location);
      expect(project.serviceEndpoint).toContain("https://");
      const observed = yield* get(project.projectName);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Project");
      expect(observed.properties?.projectStatus).toEqual("Active");

      // In place: tags.
      const updated = yield* stack.deploy(
        program({ location, tags: { env: "prod", team: "migrate" } }),
      );
      expect(updated.project.projectId).toEqual(project.projectId);
      expect(updated.project.tags).toEqual({ env: "prod", team: "migrate" });
      const reobserved = yield* get(project.projectName);
      expect(reobserved.tags?.env).toEqual("prod");
      expect(reobserved.tags?.team).toEqual("migrate");
      expect(reobserved.tags?.["alchemy::id"]).toEqual("Project");

      // Replacement: the location is immutable.
      const replaced = yield* stack.deploy(
        program({ location: "westus2", tags: { env: "prod" } }),
      );
      expect(replaced.project.location).toEqual("westus2");
      expect(replaced.project.projectName).not.toEqual(project.projectName);
      expect(yield* waitGone(get(project.projectName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.project.projectName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
