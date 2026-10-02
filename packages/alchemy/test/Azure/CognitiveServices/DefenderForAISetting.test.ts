import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  state: "Enabled" | "Disabled";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.CognitiveServices.Account("Account", {
      resourceGroup: group.resourceGroupName,
    });
    const setting = yield* Azure.CognitiveServices.DefenderForAISetting(
      "Defender",
      {
        resourceGroup: group.resourceGroupName,
        account: account.accountName,
        state: props.state,
        tags: props.tags,
      },
    );
    return { group, account, setting };
  });

// Defender for AI bills per processed token; with no traffic the run costs
// $0. The account takes ~1 minute.
test.provider(
  "enable, update, and disable defender for ai on an account",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;

      const { group, account, setting } = yield* stack.deploy(
        program({ state: "Enabled", tags: { env: "test" } }),
      );
      const get = () =>
        cognitiveservices.GetDefenderForAISettings({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          accountName: account.accountName,
          defenderForAISettingName: "Default",
        });
      expect(setting.state).toEqual("Enabled");
      const observed = yield* get();
      expect(observed.properties?.state).toEqual("Enabled");
      expect(observed.tags?.env).toEqual("test");

      // In place: tags.
      yield* stack.deploy(program({ state: "Enabled", tags: { env: "prod" } }));
      expect((yield* get()).tags?.env).toEqual("prod");

      // Deleting the resource (no delete API) switches protection off
      // while the account remains.
      yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          const account = yield* Azure.CognitiveServices.Account("Account", {
            resourceGroup: group.resourceGroupName,
          });
          return { group, account };
        }),
      );
      const disabled = yield* get();
      expect(disabled.properties?.state).toEqual("Disabled");
      expect(disabled.tags?.env).toBeUndefined();

      yield* stack.destroy();
      expect(
        yield* waitGone(
          cognitiveservices.GetAccount({
            subscriptionId,
            resourceGroupName: group.resourceGroupName,
            accountName: account.accountName,
          }),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
