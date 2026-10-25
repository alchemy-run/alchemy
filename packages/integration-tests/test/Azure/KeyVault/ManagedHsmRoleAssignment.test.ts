import * as Azure from "@alchemy.run/azure";
import * as keyvault from "@distilled.cloud/azure/keyvault";
import * as admin from "@distilled.cloud/azure/keyvault-administration";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { runExpensive } from "../gates.ts";
import { activateHsm, deployerObjectId } from "./fixtures/activate-hsm.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getAssignment = (managedHsmName: string, roleAssignmentName: string) =>
  admin
    .GetRoleAssignment({
      vaultBaseUrl: `https://${managedHsmName}.managedhsm.azure.net`,
      scope: "/keys",
      roleAssignmentName,
    })
    .pipe(
      Effect.map((assignment) => ({
        principalId: assignment.properties?.principalId,
        role: assignment.properties?.roleDefinitionId?.split("/").pop(),
      })),
      Effect.catchTag(["RoleAssignmentNotFound", "NotFound"], () => Effect.succeed(undefined)),
    );

const hsmPurged = (location: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* keyvault.GetManagedHsmDeleted({ subscriptionId, location, name }).pipe(
      Effect.as("found" as const),
      Effect.catchTag(["ResourceNotFound", "NotFound"], () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("15 seconds"),
        until: (status) => status === "gone",
        times: 40,
      }),
    );
  });

const program = (adminObjectId: string, assignee?: "A" | "B") =>
  Effect.gen(function* () {
    const hsm = yield* Azure.KeyVault.ManagedHsm("Hsm", {
      initialAdminObjectIds: [adminObjectId],
      softDeleteRetentionInDays: 7,
    });
    const a = yield* Azure.ManagedIdentity.UserAssignedIdentity("AppA", {});
    const b = yield* Azure.ManagedIdentity.UserAssignedIdentity("AppB", {});
    const assignment =
      assignee === undefined
        ? undefined
        : yield* Azure.KeyVault.ManagedHsmRoleAssignment("AppCryptoUser", {
            managedHsm: hsm.managedHsmName,
            scope: "/keys",
            roleDefinitionId: Azure.KeyVault.ManagedHsmBuiltInRole.CryptoUser,
            principalId: assignee === "A" ? a.principalId : b.principalId,
          });
    return { hsm, a, b, assignment };
  });

// ~$3/run, ~45 min: Managed HSM Standard_B1 is billed ~$3.20/hour until
// deleted and purged; provisioning takes 20-30 minutes.
test.provider.skipIf(!runExpensive)(
  "create, replace, and delete a managed HSM role assignment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const adminObjectId = yield* deployerObjectId;

      const { hsm } = yield* stack.deploy(program(adminObjectId));
      yield* activateHsm(hsm.managedHsmName);

      const created = yield* stack.deploy(program(adminObjectId, "A"));
      const first = created.assignment!;
      expect(first.scope).toEqual("/keys");
      expect(yield* getAssignment(hsm.managedHsmName, first.roleAssignmentName)).toEqual({
        principalId: created.a.principalId,
        role: Azure.KeyVault.ManagedHsmBuiltInRole.CryptoUser,
      });

      // Replacement: a new principal means a new assignment.
      const replaced = yield* stack.deploy(program(adminObjectId, "B"));
      const second = replaced.assignment!;
      expect(second.roleAssignmentName).not.toEqual(first.roleAssignmentName);
      expect(
        (yield* getAssignment(hsm.managedHsmName, second.roleAssignmentName))?.principalId,
      ).toEqual(replaced.b.principalId);
      expect(yield* getAssignment(hsm.managedHsmName, first.roleAssignmentName)).toBeUndefined();

      // Removing it from the stack deletes it from the HSM.
      yield* stack.deploy(program(adminObjectId));
      expect(yield* getAssignment(hsm.managedHsmName, second.roleAssignmentName)).toBeUndefined();

      yield* stack.destroy();
      expect(yield* hsmPurged(hsm.location, hsm.managedHsmName)).toEqual("gone");
    }),
  {
    tags: ["provider:azure", "provider:azure:keyvault", "live"],
    timeout: 7_200_000,
  },
);
