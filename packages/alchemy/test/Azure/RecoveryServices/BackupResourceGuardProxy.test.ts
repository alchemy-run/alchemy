import * as Azure from "@/Azure";
import { ensureRegistered } from "@/Azure/Arm";
import * as Test from "@/Test/Alchemy";
import * as dataprotection from "@distilled.cloud/azure/dataprotection";
import * as backup from "@distilled.cloud/azure/recoveryservicesbackup";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  createVault,
  deleteVault,
  groupOnly,
  location,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./vault.ts";

const { test } = Test.make({ providers: Azure.providers() });

const VAULT = "alchemy-test-rsv-guardproxy";
const GUARDS = ["alchemy-test-rsv-guard-a", "alchemy-test-rsv-guard-b"];

/**
 * Out-of-band resource guard (`Microsoft.DataProtection/resourceGuards`,
 * owned by the `dataprotection` service, not implemented yet). Free.
 */
const createGuard = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    const subscriptionId = yield* subscription;
    yield* ensureRegistered(subscriptionId, "Microsoft.DataProtection");
    const guard = yield* dataprotection.PutResourceGuard({
      subscriptionId,
      resourceGroupName,
      resourceGuardsName: name,
      location,
      properties: {},
    });
    expect(guard.id).toBeDefined();
    return guard.id!;
  });

const deleteGuard = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    const where = {
      subscriptionId: yield* subscription,
      resourceGroupName,
      resourceGuardsName: name,
    };
    yield* dataprotection
      .DeleteResourceGuard(where)
      .pipe(
        Effect.catchTag(["ResourceNotFound", "NotFound"], () => Effect.void),
      );
    expect(yield* waitGone(dataprotection.GetResourceGuard(where))).toEqual(
      "gone",
    );
  });

const program = (guardId: string, description: string) =>
  Effect.gen(function* () {
    const { group, owner } = yield* groupOnly;
    const proxy = yield* Azure.RecoveryServices.BackupResourceGuardProxy(
      "Proxy",
      {
        resourceGroup: group.resourceGroupName,
        vault: VAULT,
        resourceGuardResourceId: guardId,
        description,
      },
    );
    return { group, owner, proxy };
  });

const getProxy = (resourceGroupName: string) =>
  Effect.gen(function* () {
    return yield* backup.GetResourceGuardProxy2({
      subscriptionId: yield* subscription,
      resourceGroupName,
      vaultName: VAULT,
      resourceGuardProxyName: "VaultProxy",
    });
  });

// Vault and resource guard are free; ~3 minutes.
test.provider(
  "associate, update, replace, and remove a vault's resource guard",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, owner } = yield* stack.deploy(groupOnly);
      const rg = group.resourceGroupName;
      yield* createVault(rg, VAULT, owner);
      const guardA = yield* createGuard(rg, GUARDS[0]!);
      const guardB = yield* createGuard(rg, GUARDS[1]!);

      // Create.
      const created = yield* stack.deploy(program(guardA, "first"));
      expect(created.proxy.resourceGuardProxyName).toEqual("VaultProxy");
      expect(created.proxy.resourceGuardResourceId.toLowerCase()).toEqual(
        guardA.toLowerCase(),
      );
      const observed = yield* getProxy(rg);
      expect(
        observed.properties?.resourceGuardResourceId?.toLowerCase(),
      ).toEqual(guardA.toLowerCase());

      // In-place: the description is rewritten (the service does not echo
      // it back).
      const updated = yield* stack.deploy(program(guardA, "second"));
      expect(updated.proxy.resourceGuardProxyId).toEqual(
        created.proxy.resourceGuardProxyId,
      );
      expect(
        (yield* getProxy(
          rg,
        )).properties?.resourceGuardResourceId?.toLowerCase(),
      ).toEqual(guardA.toLowerCase());

      // Replacement (delete first): a vault's proxy cannot be re-pointed.
      const replaced = yield* stack.deploy(program(guardB, "second"));
      expect(replaced.proxy.resourceGuardResourceId.toLowerCase()).toEqual(
        guardB.toLowerCase(),
      );
      const repointed = yield* getProxy(rg);
      expect(
        repointed.properties?.resourceGuardResourceId?.toLowerCase(),
      ).toEqual(guardB.toLowerCase());

      // Delete: unlock through the guard, then remove the association.
      yield* stack.deploy(groupOnly);
      const after = yield* getProxy(rg).pipe(
        Effect.map((proxy) => proxy.properties?.resourceGuardResourceId),
        Effect.catchTag(["ResourceNotFound", "NotFound"], () =>
          Effect.succeed(undefined),
        ),
      );
      expect(after).toBeUndefined();

      yield* deleteGuard(rg, GUARDS[0]!);
      yield* deleteGuard(rg, GUARDS[1]!);
      yield* deleteVault(rg, VAULT);
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
