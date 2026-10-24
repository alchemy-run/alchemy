import * as Azure from "@alchemy.run/azure";
import * as migrate from "@distilled.cloud/azure/migrate";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  tool: "ServerAssessment" | "ServerDiscovery";
  status?: "Active" | "Inactive";
  extendedDetails?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const hub = yield* Azure.Migrate.MigrateProject("Hub", {
      resourceGroup: group.resourceGroupName,
      location,
    });
    const solution = yield* Azure.Migrate.Solution("Tool", {
      resourceGroup: group.resourceGroupName,
      migrateProject: hub.migrateProjectName,
      tool: props.tool,
      purpose: props.tool === "ServerAssessment" ? "Assessment" : "Discovery",
      goal: "Servers",
      status: props.status,
      extendedDetails: props.extendedDetails,
    });
    return { group, hub, solution };
  });

const getSolution = (resourceGroupName: string, migrateProjectName: string, solutionName: string) =>
  Effect.gen(function* () {
    return yield* migrate.GetSolutionsControllerSolution({
      subscriptionId: yield* subscription,
      resourceGroupName,
      migrateProjectName,
      solutionName,
    });
  });

// Free control-plane objects; under a minute.
test.provider(
  "create, update, replace, and delete a Migrate solution",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, hub, solution } = yield* stack.deploy(program({ tool: "ServerAssessment" }));
      const get = (name: string) =>
        getSolution(group.resourceGroupName, hub.migrateProjectName, name);
      expect(solution.tool).toEqual("ServerAssessment");
      expect(solution.purpose).toEqual("Assessment");
      expect(solution.goal).toEqual("Servers");
      expect(solution.status).toEqual("Active");
      expect(solution.solutionId.toLowerCase()).toContain(
        `/migrateprojects/${hub.migrateProjectName.toLowerCase()}/solutions/${solution.solutionName.toLowerCase()}`,
      );
      const observed = yield* get(solution.solutionName);
      expect(observed.properties?.tool).toEqual("ServerAssessment");

      // In place: status and extended details.
      const updated = yield* stack.deploy(
        program({
          tool: "ServerAssessment",
          status: "Inactive",
          extendedDetails: { owner: "alchemy" },
        }),
      );
      expect(updated.solution.solutionId).toEqual(solution.solutionId);
      expect(updated.solution.status).toEqual("Inactive");
      expect(updated.solution.extendedDetails).toEqual({ owner: "alchemy" });
      const reobserved = yield* get(solution.solutionName);
      expect(reobserved.properties?.status).toEqual("Inactive");
      expect(reobserved.properties?.details?.extendedDetails?.owner).toEqual("alchemy");

      // Replacement: the tool is immutable.
      const replaced = yield* stack.deploy(program({ tool: "ServerDiscovery" }));
      expect(replaced.solution.solutionName).not.toEqual(solution.solutionName);
      expect(replaced.solution.tool).toEqual("ServerDiscovery");
      expect(replaced.solution.purpose).toEqual("Discovery");
      expect(yield* waitGone(get(solution.solutionName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.solution.solutionName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
