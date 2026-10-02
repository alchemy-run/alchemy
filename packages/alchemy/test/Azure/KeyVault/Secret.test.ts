import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as keyvault from "@distilled.cloud/azure/keyvault";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getSecret = (
  resourceGroupName: string,
  vaultName: string,
  secretName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* keyvault.GetSecret({
      subscriptionId,
      resourceGroupName,
      vaultName,
      secretName,
    });
  });

const secretGone = (
  resourceGroupName: string,
  vaultName: string,
  secretName: string,
) =>
  getSecret(resourceGroupName, vaultName, secretName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const program = (secret?: {
  value: string;
  contentType: string;
  enabled: boolean;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const vault = yield* Azure.KeyVault.Vault("Vault", {
      resourceGroup: group.resourceGroupName,
      softDeleteRetentionInDays: 7,
    });
    const created = secret
      ? yield* Azure.KeyVault.Secret("DbPassword", {
          resourceGroup: group.resourceGroupName,
          vault: vault.vaultName,
          value: Redacted.make(secret.value),
          contentType: secret.contentType,
          attributes: { enabled: secret.enabled },
          tags: secret.tags,
        })
      : undefined;
    return { group, vault, secret: created };
  });

// Key Vault has no hourly charge; a few operations cost well under $0.01.
test.provider(
  "create, update, disable, and delete a key vault secret",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({
          value: "first-value",
          contentType: "text/plain",
          enabled: true,
          tags: { env: "test" },
        }),
      );
      const rg = created.group.resourceGroupName;
      const vaultName = created.vault.vaultName;
      const secret = created.secret!;
      expect(secret.secretUri).toEqual(
        `https://${vaultName}.vault.azure.net/secrets/${secret.secretName}`,
      );
      expect(secret.secretUriWithVersion).toContain(secret.secretUri);
      expect(secret.enabled).toEqual(true);
      const observed = yield* getSecret(rg, vaultName, secret.secretName);
      expect(observed.properties.contentType).toEqual("text/plain");
      expect(observed.properties.value).toBeUndefined();
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("DbPassword");

      // New value: a new version is written.
      const rotated = yield* stack.deploy(
        program({
          value: "second-value",
          contentType: "text/plain",
          enabled: true,
          tags: { env: "test" },
        }),
      );
      expect(rotated.secret!.secretName).toEqual(secret.secretName);
      expect(rotated.secret!.secretUriWithVersion).not.toEqual(
        secret.secretUriWithVersion,
      );

      // In-place update of metadata: content type, tags, and attributes.
      const updated = yield* stack.deploy(
        program({
          value: "second-value",
          contentType: "application/json",
          enabled: false,
          tags: { env: "prod" },
        }),
      );
      expect(updated.secret!.secretName).toEqual(secret.secretName);
      expect(updated.secret!.enabled).toEqual(false);
      const reobserved = yield* getSecret(rg, vaultName, secret.secretName);
      expect(reobserved.properties.contentType).toEqual("application/json");
      expect(reobserved.properties.attributes?.enabled).toEqual(false);
      expect(reobserved.tags?.env).toEqual("prod");

      // Re-enable, then remove the secret from the stack: ARM cannot delete
      // secrets, so the provider disables it.
      yield* stack.deploy(
        program({
          value: "second-value",
          contentType: "application/json",
          enabled: true,
          tags: { env: "prod" },
        }),
      );
      expect(
        (yield* getSecret(rg, vaultName, secret.secretName)).properties
          .attributes?.enabled,
      ).toEqual(true);
      yield* stack.deploy(program());
      expect(
        (yield* getSecret(rg, vaultName, secret.secretName)).properties
          .attributes?.enabled,
      ).toEqual(false);

      // Destroying the vault (deleted + purged) removes the secret.
      yield* stack.destroy();
      expect(yield* secretGone(rg, vaultName, secret.secretName)).toEqual(
        "gone",
      );
    }),
  {
    tags: ["provider:azure", "provider:azure:keyvault", "live"],
    timeout: 900_000,
  },
);
