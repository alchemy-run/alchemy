import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = [
  "provider:azure",
  "provider:azure:siterecovery",
  "live",
];

/** Vault region; the primary fabric is in `PRIMARY`, recovery in `RECOVERY`. */
export const VAULT_LOCATION = "westus2";
export const PRIMARY = "eastus";
export const RECOVERY = "westus2";

export const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/** Resource group + Recovery Services vault (both free). */
export const vaultStack = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: VAULT_LOCATION,
  });
  const vault = yield* Azure.RecoveryServices.Vault("Vault", {
    resourceGroup: group.resourceGroupName,
    location: VAULT_LOCATION,
  });
  return { group, vault };
});

/** Vault plus A2A primary/recovery fabrics and containers (~3 minutes). */
export const fabricsStack = Effect.gen(function* () {
  const { group, vault } = yield* vaultStack;
  const base = {
    resourceGroup: group.resourceGroupName,
    vault: vault.vaultName,
  };
  const primary = yield* Azure.SiteRecovery.Fabric("Primary", {
    ...base,
    location: PRIMARY,
  });
  const recovery = yield* Azure.SiteRecovery.Fabric("Recovery", {
    ...base,
    location: RECOVERY,
  });
  return { group, vault, base, primary, recovery };
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
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times: 36,
    }),
  );
