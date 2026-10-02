import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  name: string;
  capacity: number;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.CognitiveServices.Account("Account", {
      resourceGroup: group.resourceGroupName,
    });
    const deployment = yield* Azure.CognitiveServices.Deployment("Chat", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      name: props.name,
      model: { format: "OpenAI", name: "gpt-4.1-mini", version: "2025-04-14" },
      sku: { name: "GlobalStandard", capacity: props.capacity },
      tags: props.tags,
    });
    return { group, account, deployment };
  });

// GlobalStandard deployments bill per token only: $0 idle, ~1 minute.
test.provider(
  "create, update, replace, and delete a model deployment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;

      const { group, account, deployment } = yield* stack.deploy(
        program({ name: "alchemy-chat-a", capacity: 1, tags: { env: "test" } }),
      );
      const get = (deploymentName: string) =>
        cognitiveservices.GetDeployment({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          accountName: account.accountName,
          deploymentName,
        });
      expect(deployment.modelName).toEqual("gpt-4.1-mini");
      const observed = yield* get("alchemy-chat-a");
      expect(observed.properties?.model?.version).toEqual("2025-04-14");
      expect(observed.sku?.name).toEqual("GlobalStandard");
      expect(observed.sku?.capacity).toEqual(1);
      expect(observed.tags?.env).toEqual("test");

      // In place: capacity and tags.
      const updated = yield* stack.deploy(
        program({ name: "alchemy-chat-a", capacity: 2, tags: { env: "prod" } }),
      );
      expect(updated.deployment.deploymentId).toEqual(deployment.deploymentId);
      const reobserved = yield* get("alchemy-chat-a");
      expect(reobserved.sku?.capacity).toEqual(2);
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: the name is immutable.
      yield* stack.deploy(
        program({ name: "alchemy-chat-b", capacity: 2, tags: { env: "prod" } }),
      );
      expect((yield* get("alchemy-chat-b")).sku?.capacity).toEqual(2);
      expect(yield* waitGone(get("alchemy-chat-a"))).toEqual("gone");

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
