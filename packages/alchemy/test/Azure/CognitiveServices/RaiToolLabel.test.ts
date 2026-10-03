import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  toolConnectionName: string;
  confidentiality: "Confidential" | "Non-confidential";
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.CognitiveServices.Account("Account", {
      resourceGroup: group.resourceGroupName,
    });
    const label = yield* Azure.CognitiveServices.RaiToolLabel("Label", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      toolConnectionName: props.toolConnectionName,
      accountLabels: { DataConfidentiality: props.confidentiality },
      tags: { env: "test" },
    });
    return { group, account, label };
  });

// S0 AIServices account + tool label (preview): $0 idle, ~1 minute.
test.provider(
  "create, update, replace, and delete a rai tool label",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;

      const { group, account, label } = yield* stack.deploy(
        program({
          toolConnectionName: "Alchemy_Search_A",
          confidentiality: "Confidential",
        }),
      );
      const get = (raiToolConnectionName: string) =>
        cognitiveservices.GetRaiToolLabel({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          accountName: account.accountName,
          raiToolConnectionName,
        });
      expect(Object.values(label.accountLabels)).toEqual(["Confidential"]);
      const observed = yield* get("Alchemy_Search_A");
      expect(observed.properties?.toolConnectionName).toEqual(
        "Alchemy_Search_A",
      );
      expect(observed.tags?.env).toEqual("test");

      // In place: label value.
      yield* stack.deploy(
        program({
          toolConnectionName: "Alchemy_Search_A",
          confidentiality: "Non-confidential",
        }),
      );
      const reobserved = yield* get("Alchemy_Search_A");
      expect(
        Object.values(reobserved.properties?.accountScope?.labelValues ?? {}),
      ).toEqual(["Non-confidential"]);

      // Replacement: the tool connection name is the resource name.
      yield* stack.deploy(
        program({
          toolConnectionName: "Alchemy_Search_B",
          confidentiality: "Non-confidential",
        }),
      );
      expect(
        (yield* get("Alchemy_Search_B")).properties?.toolConnectionName,
      ).toEqual("Alchemy_Search_B");
      expect(yield* waitGone(get("Alchemy_Search_A"))).toEqual("gone");

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
