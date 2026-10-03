import * as Azure from "@/Azure";
import { ensureRegistered, stackAndStage } from "@/Azure/Arm";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as recoveryservices from "@distilled.cloud/azure/recoveryservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = [
  "provider:azure",
  "provider:azure:recoveryservices",
  "live",
];

export const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

export const location = "eastus";

/**
 * A stack with only the resource group. It also reports the stack/stage
 * so the out-of-band vault can carry the same ownership tags an
 * Alchemy-managed vault would.
 */
export const groupOnly = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", { location });
  const owner = yield* stackAndStage;
  return { group, owner };
});

/**
 * Out-of-band Recovery Services vault (the `recoveryservices` service is
 * not part of this namespace). The vault itself is free. New vaults start
 * with soft delete `AlwaysON` (still editable until changed); passing
 * `securitySettings` at create time leaves the vault provisioning for
 * minutes, so tests that protect items disable soft delete with
 * `BackupVaultConfig` instead.
 */
export const createVault = (
  resourceGroupName: string,
  vaultName: string,
  owner: { stack: string; stage: string },
  options: { systemAssignedIdentity?: boolean } = {},
) =>
  Effect.gen(function* () {
    const subscriptionId = yield* subscription;
    yield* ensureRegistered(subscriptionId, "Microsoft.RecoveryServices");
    yield* recoveryservices.VaultsCreateOrUpdate({
      subscriptionId,
      resourceGroupName,
      vaultName,
      location,
      sku: { name: "RS0", tier: "Standard" },
      ...(options.systemAssignedIdentity
        ? { identity: { type: "SystemAssigned" } }
        : {}),
      tags: { "alchemy::stack": owner.stack, "alchemy::stage": owner.stage },
      properties: {
        publicNetworkAccess: "Enabled",
      },
    });
    const vault = yield* recoveryservices
      .GetVault({ subscriptionId, resourceGroupName, vaultName })
      .pipe(
        Effect.retry({
          while: (e) => e._tag === "ResourceNotFound" || e._tag === "NotFound",
          schedule: Schedule.spaced("3 seconds"),
          times: 20,
        }),
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (vault) => vault.properties?.provisioningState === "Succeeded",
          times: 40,
        }),
      );
    expect(vault.properties?.provisioningState).toEqual("Succeeded");
    return vault;
  });

/** Delete the out-of-band vault and wait until it is gone. */
export const deleteVault = (resourceGroupName: string, vaultName: string) =>
  Effect.gen(function* () {
    const subscriptionId = yield* subscription;
    const where = { subscriptionId, resourceGroupName, vaultName };
    yield* recoveryservices
      .DeleteVault(where)
      .pipe(
        Effect.catchTag(
          ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
          () => Effect.void,
        ),
      );
    expect(yield* waitGone(recoveryservices.GetVault(where))).toEqual("gone");
  });

/** Poll an out-of-band GET until it reports a typed not-found. */
export const waitGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );
