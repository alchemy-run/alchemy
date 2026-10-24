import * as Azure from "@alchemy.run/azure";
import * as recoveryservices from "@distilled.cloud/azure/recoveryservices";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { location, logLevel, subscription, tags, waitGone } from "./vault.ts";

const { test } = Test.make({ providers: Azure.providers() });

/** Base64 of the 16 bytes `alchemy-testkey1`. */
const KEY = "YWxjaGVteS10ZXN0a2V5MQ==";

/** Base64 of the bytes `alchemy-enckey-01`. */
const ENCRYPTION_KEY = "YWxjaGVteS1lbmNrZXktMDE=";

const program = (props: {
  vault: "A" | "B";
  integrityKey?: string;
  encryptionKey?: string;
  encryptionKeyThumbprint?: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const vault = yield* Azure.RecoveryServices.Vault(`Vault${props.vault}`, {
      resourceGroup: group.resourceGroupName,
      storageRedundancy: "LocallyRedundant",
    });
    const info = yield* Azure.RecoveryServices.VaultExtendedInfo("Info", {
      resourceGroup: group.resourceGroupName,
      vault: vault.vaultName,
      integrityKey:
        props.integrityKey === undefined ? undefined : Redacted.make(props.integrityKey),
      encryptionKey:
        props.encryptionKey === undefined ? undefined : Redacted.make(props.encryptionKey),
      encryptionKeyThumbprint: props.encryptionKeyThumbprint,
    });
    return { group, vault, info };
  });

const getInfo = (resourceGroupName: string, vaultName: string) =>
  Effect.gen(function* () {
    const subscriptionId = yield* subscription;
    return yield* recoveryservices.GetVaultExtendedInfo({
      subscriptionId,
      resourceGroupName,
      vaultName,
    });
  });

const reveal = (value: Redacted.Redacted<string> | undefined) =>
  value === undefined ? "" : Redacted.value(value);

// Empty vaults are free; each vault create/delete takes about a minute.
test.provider(
  "create, update, replace, and delete a vault's extended info",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create: a random integrity key is generated.
      const created = yield* stack.deploy(program({ vault: "A" }));
      const rg = created.group.resourceGroupName;
      const vaultA = created.vault.vaultName;
      const generated = reveal(created.info.integrityKey);
      expect(generated).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      expect(created.info.algorithm).toEqual("None");
      expect(created.info.extendedInfoId.toLowerCase()).toContain(
        `/vaults/${vaultA.toLowerCase()}/extendedinformation/vaultextendedinfo`,
      );
      const observed = yield* getInfo(rg, vaultA);
      expect(observed.properties?.integrityKey).toEqual(generated);
      expect(observed.properties?.algorithm).toEqual("None");

      // A redeploy without a key keeps the observed key.
      const kept = yield* stack.deploy(program({ vault: "A" }));
      expect(reveal(kept.info.integrityKey)).toEqual(generated);

      // Write-once: changing the key fails with the typed error and leaves
      // the observed key unchanged.
      const error = yield* stack
        .deploy(program({ vault: "A", integrityKey: KEY }))
        .pipe(Effect.flip);
      expect(error._tag).toEqual("VaultExtendedInfoAlreadySet");
      expect((yield* getInfo(rg, vaultA)).properties?.integrityKey).toEqual(generated);

      // Replacement: a new vault gets its own extended info with the chosen
      // keys; vault A is deleted.
      const props = {
        vault: "B",
        integrityKey: KEY,
        encryptionKey: ENCRYPTION_KEY,
        encryptionKeyThumbprint: "0123456789ABCDEF0123456789ABCDEF01234567",
      } as const;
      const replaced = yield* stack.deploy(program(props));
      const vaultB = replaced.vault.vaultName;
      expect(vaultB).not.toEqual(vaultA);
      expect(replaced.info.vault).toEqual(vaultB);
      expect(reveal(replaced.info.integrityKey)).toEqual(KEY);
      expect(replaced.info.encryptionKeyThumbprint).toEqual(props.encryptionKeyThumbprint);
      const onB = yield* getInfo(rg, vaultB);
      expect(onB.properties?.integrityKey).toEqual(KEY);
      expect(onB.properties?.encryptionKeyThumbprint).toEqual(props.encryptionKeyThumbprint);
      expect(yield* waitGone(getInfo(rg, vaultA))).toEqual("gone");

      // Matching settings converge without a write.
      const again = yield* stack.deploy(program(props));
      expect(reveal(again.info.integrityKey)).toEqual(KEY);

      yield* stack.destroy();

      expect(yield* waitGone(getInfo(rg, vaultB))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
