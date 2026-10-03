import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as msi from "@distilled.cloud/azure/msi";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const assignmentGone = (scope: string, roleAssignmentName: string) =>
  authorization.GetRoleAssignment({ scope, roleAssignmentName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["RoleAssignmentNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const program = (description: string) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("Api", {
      resourceGroup: group.resourceGroupName,
      tags: { role: "api" },
    });
    const assignment = yield* Azure.Authorization.RoleAssignment(
      "ApiReadsGroup",
      {
        scope: group.resourceGroupId,
        roleDefinitionId: Azure.Authorization.BuiltInRole.Reader,
        principalId: identity.principalId,
        principalType: "ServicePrincipal",
        description,
      },
    );
    return { group, identity, assignment };
  });

test.provider(
  "grant a managed identity a role on a resource group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, identity, assignment } = yield* stack.deploy(
        program("api reads the group"),
      );

      expect(identity.principalId).toMatch(/^[0-9a-f-]{36}$/);
      expect(identity.clientId).toMatch(/^[0-9a-f-]{36}$/);
      expect(identity.tags).toEqual({ role: "api" });
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      const observedIdentity = yield* msi.GetUserAssignedIdentity({
        subscriptionId,
        resourceGroupName: group.resourceGroupName,
        resourceName: identity.identityName,
      });
      expect(observedIdentity.properties?.principalId).toEqual(
        identity.principalId,
      );

      expect(assignment.roleAssignmentName).toMatch(/^[0-9a-f-]{36}$/);
      expect(assignment.principalId).toEqual(identity.principalId);
      expect(assignment.roleDefinitionId.toLowerCase()).toContain(
        Azure.Authorization.BuiltInRole.Reader,
      );
      const observed = yield* authorization.GetRoleAssignment({
        scope: group.resourceGroupId,
        roleAssignmentName: assignment.roleAssignmentName,
      });
      expect(observed.properties?.principalId).toEqual(identity.principalId);
      expect(observed.properties?.description).toMatch(
        /^api reads the group \[alchemy .+\/ApiReadsGroup\]$/,
      );

      // Description is mutable in place.
      const updated = yield* stack.deploy(program("api reads everything"));
      expect(updated.assignment.roleAssignmentName).toEqual(
        assignment.roleAssignmentName,
      );
      const reobserved = yield* authorization.GetRoleAssignment({
        scope: group.resourceGroupId,
        roleAssignmentName: assignment.roleAssignmentName,
      });
      expect(reobserved.properties?.description).toMatch(
        /^api reads everything \[alchemy /,
      );

      yield* stack.destroy();
      expect(
        yield* assignmentGone(
          group.resourceGroupId,
          assignment.roleAssignmentName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:authorization", "live"],
    timeout: 600_000,
  },
);
