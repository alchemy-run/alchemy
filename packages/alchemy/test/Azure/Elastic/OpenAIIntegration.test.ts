import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import * as elastic from "@distilled.cloud/azure/elastic";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { runPaidOnly } from "../gates.ts";
import {
  location,
  logLevel,
  subscription,
  tags,
  userInfo,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getIntegration = (
  resourceGroupName: string,
  monitorName: string,
  integrationName: string,
) =>
  Effect.gen(function* () {
    return yield* elastic.GetOpenAI({
      subscriptionId: yield* subscription,
      resourceGroupName,
      monitorName,
      integrationName,
    });
  });

const listKeys = (resourceGroupName: string, accountName: string) =>
  Effect.gen(function* () {
    const keys = yield* cognitiveservices.ListAccountKeys({
      subscriptionId: yield* subscription,
      resourceGroupName,
      accountName,
    });
    return { key1: keys.key1 ?? "", key2: keys.key2 ?? "" };
  });

const base = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", { location });
  const account = yield* Azure.CognitiveServices.Account("OpenAI", {
    resourceGroup: group.resourceGroupName,
    location,
    kind: "OpenAI",
    sku: "S0",
  });
  const monitor = yield* Azure.Elastic.Monitor("Monitor", {
    resourceGroup: group.resourceGroupName,
    location,
    userInfo,
  });
  return { group, account, monitor };
});

const program = (key: string) =>
  Effect.gen(function* () {
    const { group, account, monitor } = yield* base;
    const integration = yield* Azure.Elastic.OpenAIIntegration("Integration", {
      resourceGroup: group.resourceGroupName,
      monitor: monitor.monitorName,
      openAIResourceId: account.accountId,
      openAIResourceEndpoint: Output.map(
        account.endpoint,
        (endpoint) => endpoint ?? "",
      ),
      key: Redacted.make(key),
    });
    return { group, account, monitor, integration };
  });

// Needs an Elastic monitor (Marketplace SaaS purchase + hosted deployment,
// ~$0.50-1/hour, ~10-50 minutes; the free trial cannot create one, see the
// Monitor probe) plus an Azure OpenAI account (no charge while idle). Run
// only with AZURE_TEST_PAID=1.
test.provider.skipIf(!runPaidOnly)(
  "create, rotate the key of, and delete an elastic openai integration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account } = yield* stack.deploy(base);
      const keys = yield* listKeys(group.resourceGroupName, account.accountName);

      const { monitor, integration } = yield* stack.deploy(program(keys.key1));
      const observed = yield* getIntegration(
        group.resourceGroupName,
        monitor.monitorName,
        integration.integrationName,
      );
      expect(observed.properties?.openAIResourceId?.toLowerCase()).toEqual(
        account.accountId.toLowerCase(),
      );
      expect(observed.properties?.openAIResourceEndpoint).toEqual(
        account.endpoint,
      );

      // In place: rotate to the second key.
      const rotated = yield* stack.deploy(program(keys.key2));
      expect(rotated.integration.integrationId).toEqual(
        integration.integrationId,
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getIntegration(
            group.resourceGroupName,
            monitor.monitorName,
            integration.integrationName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 5_400_000 },
);
