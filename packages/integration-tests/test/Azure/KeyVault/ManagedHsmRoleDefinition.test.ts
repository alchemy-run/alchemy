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

const getRole = (managedHsmName: string, roleDefinitionName: string) =>
  admin
    .GetRoleDefinition({
      vaultBaseUrl: `https://${managedHsmName}.managedhsm.azure.net`,
      scope: "/",
      roleDefinitionName,
    })
    .pipe(
      Effect.map((role) => ({
        roleName: role.properties?.roleName,
        type: role.properties?.type,
        description: role.properties?.description,
        dataActions: [...(role.properties?.permissions?.[0]?.dataActions ?? [])].sort(),
      })),
      Effect.catchTag(["RoleDefinitionNotFound", "NotFound"], () => Effect.succeed(undefined)),
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

const program = (adminObjectId: string, dataActions?: Azure.KeyVault.ManagedHsmDataAction[]) =>
  Effect.gen(function* () {
    const hsm = yield* Azure.KeyVault.ManagedHsm("Hsm", {
      initialAdminObjectIds: [adminObjectId],
      softDeleteRetentionInDays: 7,
    });
    const role =
      dataActions === undefined
        ? undefined
        : yield* Azure.KeyVault.ManagedHsmRoleDefinition("KeyReader", {
            managedHsm: hsm.managedHsmName,
            description: "Reads keys",
            dataActions,
          });
    return { hsm, role };
  });

// ~$3/run, ~45 min: Managed HSM Standard_B1 is billed ~$3.20/hour until
// deleted and purged; provisioning takes 20-30 minutes.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a managed HSM role definition",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const adminObjectId = yield* deployerObjectId;

      const { hsm } = yield* stack.deploy(program(adminObjectId));
      yield* activateHsm(hsm.managedHsmName);

      const created = yield* stack.deploy(
        program(adminObjectId, ["Microsoft.KeyVault/managedHsm/keys/read/action"]),
      );
      const role = created.role!;
      expect(role.roleDefinitionId).toEqual(
        `Microsoft.KeyVault/providers/Microsoft.Authorization/roleDefinitions/${role.roleDefinitionName}`,
      );
      const observed = yield* getRole(hsm.managedHsmName, role.roleDefinitionName);
      expect(observed?.roleName).toEqual(role.roleName);
      expect(observed?.type).toEqual("CustomRole");
      expect(observed?.description).toMatch(/^Reads keys \[alchemy .+\/KeyReader\]$/);
      expect(observed?.dataActions).toEqual(["Microsoft.KeyVault/managedHsm/keys/read/action"]);

      // In-place update: data actions.
      const updated = yield* stack.deploy(
        program(adminObjectId, [
          "Microsoft.KeyVault/managedHsm/keys/read/action",
          "Microsoft.KeyVault/managedHsm/keys/backup/action",
        ]),
      );
      expect(updated.role!.roleDefinitionName).toEqual(role.roleDefinitionName);
      expect((yield* getRole(hsm.managedHsmName, role.roleDefinitionName))?.dataActions).toEqual([
        "Microsoft.KeyVault/managedHsm/keys/backup/action",
        "Microsoft.KeyVault/managedHsm/keys/read/action",
      ]);

      // Removing it from the stack deletes it from the HSM.
      yield* stack.deploy(program(adminObjectId));
      expect(yield* getRole(hsm.managedHsmName, role.roleDefinitionName)).toBeUndefined();

      yield* stack.destroy();
      expect(yield* hsmPurged(hsm.location, hsm.managedHsmName)).toEqual("gone");
    }),
  {
    tags: ["provider:azure", "provider:azure:keyvault", "live"],
    timeout: 7_200_000,
  },
);
