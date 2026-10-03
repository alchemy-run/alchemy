import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as keyvault from "@distilled.cloud/azure/keyvault";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

/**
 * Keys need an *activated* managed HSM (security domain downloaded, a
 * data-plane step with RSA certificates). Provide one as
 * `AZURE_TEST_MANAGED_HSM=<resourceGroup>/<hsmName>`; the test does not
 * create or delete the HSM.
 */
const [hsmGroup, hsmName] = (process.env.AZURE_TEST_MANAGED_HSM ?? "/").split(
  "/",
);
const hasHsm = !!hsmGroup && !!hsmName;

const getKey = (keyName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* keyvault.GetManagedHsmKey({
      subscriptionId,
      resourceGroupName: hsmGroup!,
      name: hsmName!,
      keyName,
    });
  });

const program = (keySize: number) =>
  Effect.gen(function* () {
    const key = yield* Azure.KeyVault.ManagedHsmKey("Cmk", {
      resourceGroup: hsmGroup!,
      managedHsm: hsmName!,
      kty: "RSA-HSM",
      keySize,
      tags: { purpose: "cmk" },
    });
    return { key };
  });

// HSM keys cost ~$1/key/month (prorated) plus the HSM's ~$3.20/hour, which
// is billed regardless of this test.
test.provider.skipIf(!runExpensive || !hasHsm)(
  "create and replace a managed HSM key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { key } = yield* stack.deploy(program(2048));
      expect(key.kty).toEqual("RSA-HSM");
      expect(key.keyUri).toContain(`${hsmName}.managedhsm.azure.net/keys/`);
      const observed = yield* getKey(key.keyName);
      expect(observed.properties.keySize).toEqual(2048);
      expect(observed.tags?.["alchemy::id"]).toEqual("Cmk");

      // ARM cannot change a key: a new key size replaces it.
      const replaced = yield* stack.deploy(program(3072));
      expect(replaced.key.keyName).not.toEqual(key.keyName);
      expect((yield* getKey(replaced.key.keyName)).properties.keySize).toEqual(
        3072,
      );

      // ARM has no key delete; destroy only forgets the keys.
      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:keyvault", "live"],
    timeout: 900_000,
  },
);
