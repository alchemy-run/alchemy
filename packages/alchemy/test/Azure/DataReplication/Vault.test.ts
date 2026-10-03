import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as dr from "@distilled.cloud/azure/recoveryservicesdatareplication";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { LOCATION, logLevel, subscription, tags, waitGone } from "./shared.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  tags: Record<string, string>;
  vaultType?: "DisasterRecovery" | "Migrate";
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const vault = yield* Azure.DataReplication.Vault("Vault", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      ...props,
    });
    return { group, vault };
  });

const getVault = (resourceGroupName: string, vaultName: string) =>
  Effect.gen(function* () {
    return yield* dr.GetVault({
      subscriptionId: yield* subscription,
      resourceGroupName,
      vaultName,
    });
  });

// Vaults are free (charges are per protected instance); ~3 minutes each.
test.provider(
  "create, update tags, replace, and delete a data replication vault",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ tags: { env: "test" } }));
      const rg = created.group.resourceGroupName;
      expect(created.vault.vaultType).toEqual("DisasterRecovery");
      const observed = yield* getVault(rg, created.vault.vaultName);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Vault");

      // In-place: tags.
      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.vault.vaultId).toEqual(created.vault.vaultId);
      expect((yield* getVault(rg, created.vault.vaultName)).tags?.env).toEqual(
        "prod",
      );

      // Replace: vaultType is immutable.
      const replaced = yield* stack.deploy(
        program({ tags: { env: "prod" }, vaultType: "Migrate" }),
      );
      expect(replaced.vault.vaultType).toEqual("Migrate");
      expect(replaced.vault.vaultName).not.toEqual(created.vault.vaultName);
      expect(yield* waitGone(getVault(rg, created.vault.vaultName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(yield* waitGone(getVault(rg, replaced.vault.vaultName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
