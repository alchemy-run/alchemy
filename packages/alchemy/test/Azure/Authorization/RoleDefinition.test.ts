import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as authorization from "@distilled.cloud/azure/authorization";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const definitionGone = (scope: string, roleDefinitionId: string) =>
  authorization.GetRoleDefinition({ scope, roleDefinitionId }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["RoleDefinitionNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 20,
    }),
  );

const READ = "Microsoft.Storage/storageAccounts/read";
const LIST_KEYS = "Microsoft.Storage/storageAccounts/listKeys/action";

const program = (opts: {
  location: string;
  description: string;
  actions: string[];
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: opts.location,
    });
    const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("Api", {
      resourceGroup: group.resourceGroupName,
    });
    const role = yield* Azure.Authorization.RoleDefinition("StorageReader", {
      scope: group.resourceGroupId,
      description: opts.description,
      permissions: [{ actions: opts.actions }],
    });
    const assignment = yield* Azure.Authorization.RoleAssignment(
      "ApiReadsStorage",
      {
        scope: group.resourceGroupId,
        roleDefinitionId: role.roleDefinitionId,
        principalId: identity.principalId,
        principalType: "ServicePrincipal",
      },
    );
    return { group, role, assignment };
  });

test.provider(
  "create, update and delete a custom role assigned to an identity",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, role, assignment } = yield* stack.deploy(
        program({
          location: "eastus",
          description: "reads storage",
          actions: [READ],
        }),
      );

      expect(role.roleDefinitionName).toMatch(/^[0-9a-f-]{36}$/);
      expect(role.roleDefinitionId.toLowerCase()).toContain(
        `/providers/microsoft.authorization/roledefinitions/${role.roleDefinitionName}`,
      );
      expect(role.roleName.length).toBeGreaterThan(16);
      expect(role.roleName.length).toBeLessThanOrEqual(128);
      expect(role.assignableScopes.map((s) => s.toLowerCase())).toEqual([
        group.resourceGroupId.toLowerCase(),
      ]);
      expect(assignment.roleDefinitionId.toLowerCase()).toContain(
        role.roleDefinitionName,
      );

      const observed = yield* authorization.GetRoleDefinition({
        scope: group.resourceGroupId,
        roleDefinitionId: role.roleDefinitionName,
      });
      expect(observed.properties?.type).toEqual("CustomRole");
      expect(observed.properties?.description).toMatch(
        /^reads storage \[alchemy .+\/StorageReader\]$/,
      );
      expect(observed.properties?.permissions?.[0]?.actions).toEqual([READ]);

      // Permissions and description are mutable in place.
      const updated = yield* stack.deploy(
        program({
          location: "eastus",
          description: "reads storage and keys",
          actions: [READ, LIST_KEYS],
        }),
      );
      expect(updated.role.roleDefinitionName).toEqual(role.roleDefinitionName);
      const reobserved = yield* authorization
        .GetRoleDefinition({
          scope: group.resourceGroupId,
          roleDefinitionId: role.roleDefinitionName,
        })
        .pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (d) =>
              (d.properties?.permissions?.[0]?.actions ?? []).length === 2,
            times: 15,
          }),
        );
      expect(reobserved.properties?.description).toMatch(
        /^reads storage and keys \[alchemy /,
      );
      expect(
        [...(reobserved.properties?.permissions?.[0]?.actions ?? [])].sort(),
      ).toEqual([LIST_KEYS, READ].sort());

      // Moving the scope (a new resource group) replaces the role.
      const replaced = yield* stack.deploy(
        program({
          location: "westus2",
          description: "reads storage and keys",
          actions: [READ, LIST_KEYS],
        }),
      );
      expect(replaced.group.resourceGroupId).not.toEqual(group.resourceGroupId);
      expect(replaced.role.roleDefinitionName).not.toEqual(
        role.roleDefinitionName,
      );
      expect(
        yield* definitionGone(group.resourceGroupId, role.roleDefinitionName),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* definitionGone(
          replaced.group.resourceGroupId,
          replaced.role.roleDefinitionName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:authorization", "live"],
    timeout: 900_000,
  },
);
