import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const foundry = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const account = yield* Azure.CognitiveServices.Account("Foundry", {
    resourceGroup: group.resourceGroupName,
    allowProjectManagement: true,
    identity: { type: "SystemAssigned" },
  });
  return { group, account };
});

const program = (props: { name: string; state: "Enabled" | "Disabled" }) =>
  Effect.gen(function* () {
    const { group, account } = yield* foundry;
    const scope = yield* Azure.CognitiveServices.EncryptionScope("Scope", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      name: props.name,
      keySource: "Microsoft.CognitiveServices",
      state: props.state,
      tags: { env: "test" },
    });
    return { group, account, scope };
  });

// Encryption scopes are allow-listed by Microsoft: the pay-as-you-go testing
// subscription gets `EncryptionScopeNotSupported` for AIServices and OpenAI
// accounts in eastus and swedencentral, on api-versions 2024-10-01 through
// 2026-09-15-preview, with either key source, and with account-level CMK
// configured (the probe below pins the typed rejection). Set
// AZURE_TEST_COGNITIVE_ENCRYPTION_SCOPES=1 on an allow-listed subscription.
// $0 idle, ~2 minutes.
test.provider.skipIf(!process.env.AZURE_TEST_COGNITIVE_ENCRYPTION_SCOPES)(
  "create, update, replace, and delete an encryption scope",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;

      const { group, account } = yield* stack.deploy(
        program({ name: "alchemy-scope-a", state: "Enabled" }),
      );
      const get = (encryptionScopeName: string) =>
        cognitiveservices.GetEncryptionScope({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          accountName: account.accountName,
          encryptionScopeName,
        });
      expect((yield* get("alchemy-scope-a")).properties?.state).toEqual(
        "Enabled",
      );

      // In place: disable the scope.
      yield* stack.deploy(
        program({ name: "alchemy-scope-a", state: "Disabled" }),
      );
      expect((yield* get("alchemy-scope-a")).properties?.state).toEqual(
        "Disabled",
      );

      // Replacement: the name is immutable.
      yield* stack.deploy(
        program({ name: "alchemy-scope-b", state: "Disabled" }),
      );
      expect((yield* get("alchemy-scope-b")).properties?.state).toEqual(
        "Disabled",
      );
      expect(yield* waitGone(get("alchemy-scope-a"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("alchemy-scope-b"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe: an S0 Foundry account in eastus ($0, ~1 minute) rejects
// encryption scopes with the typed not-supported error.
test.provider(
  "encryption scopes are rejected with a typed error where unsupported",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group, account } = yield* stack.deploy(foundry);
      const error = yield* cognitiveservices
        .EncryptionScopesCreateOrUpdate({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          accountName: account.accountName,
          encryptionScopeName: "probe",
          properties: {
            keySource: "Microsoft.CognitiveServices",
            state: "Enabled",
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual(
        "CognitiveServicesEncryptionScopeNotSupported",
      );
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
