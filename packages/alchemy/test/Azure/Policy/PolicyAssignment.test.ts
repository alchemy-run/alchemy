import * as Azure from "@/Azure";
import { orUndefinedIfNotFound } from "@/Azure/Arm";
import * as Test from "@/Test/Alchemy";
import * as resources from "@distilled.cloud/azure/resources";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getAssignment = (scope: string, policyAssignmentName: string) =>
  orUndefinedIfNotFound(
    resources.GetPolicyAssignment({ scope, policyAssignmentName }),
  );

const assignmentGone = (scope: string, name: string) =>
  getAssignment(scope, name).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (observed) => observed === undefined,
      times: 10,
    }),
  );

const program = (tagName: string, displayName: string) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const definition = yield* Azure.Policy.PolicyDefinition("RequireTagRule", {
      mode: "Indexed",
      parameters: { tagName: { type: "String" } },
      policyRule: {
        if: {
          field: "[concat('tags[', parameters('tagName'), ']')]",
          exists: "false",
        },
        then: { effect: "audit" },
      },
    });
    const assignment = yield* Azure.Policy.PolicyAssignment("RequireTag", {
      scope: group.resourceGroupId,
      policyDefinitionId: definition.policyDefinitionId,
      displayName,
      parameters: { tagName },
      enforcementMode: "DoNotEnforce",
      nonComplianceMessages: [{ message: `Tag ${tagName} is required` }],
    });
    return { group, definition, assignment };
  });

test.provider(
  "assign a custom policy to a resource group, update it, and delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, definition, assignment } = yield* stack.deploy(
        program("owner", "Require owner"),
      );
      expect(assignment.scope.toLowerCase()).toEqual(
        group.resourceGroupId.toLowerCase(),
      );
      expect(assignment.policyDefinitionId.toLowerCase()).toEqual(
        definition.policyDefinitionId.toLowerCase(),
      );
      expect(assignment.enforcementMode).toEqual("DoNotEnforce");
      const observed = yield* getAssignment(
        group.resourceGroupId,
        assignment.policyAssignmentName,
      );
      expect(observed?.properties?.parameters?.tagName?.value).toEqual("owner");
      expect(observed?.properties?.displayName).toEqual("Require owner");

      // Parameters, display name and messages are mutable in place.
      const updated = yield* stack.deploy(program("team", "Require team"));
      expect(updated.assignment.policyAssignmentName).toEqual(
        assignment.policyAssignmentName,
      );
      const reobserved = yield* getAssignment(
        group.resourceGroupId,
        assignment.policyAssignmentName,
      );
      expect(reobserved?.properties?.parameters?.tagName?.value).toEqual(
        "team",
      );
      expect(reobserved?.properties?.displayName).toEqual("Require team");
      expect(reobserved?.properties?.nonComplianceMessages?.[0]?.message).toEqual(
        "Tag team is required",
      );

      yield* stack.destroy();
      expect(
        yield* assignmentGone(
          group.resourceGroupId,
          assignment.policyAssignmentName,
        ),
      ).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:policy", "live"],
    timeout: 600_000,
  },
);
