import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as ml from "@distilled.cloud/azure/machinelearningservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { baseProject, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const llama =
  "azureml://registries/azureml-meta/models/Meta-Llama-3-8B-Instruct";
const mistral = "azureml://registries/azureml-mistral/models/Mistral-small";

const getSubscription = (
  resourceGroupName: string,
  workspaceName: string,
  name: string,
) =>
  Effect.gen(function* () {
    return yield* ml.GetMarketplaceSubscription({
      subscriptionId: yield* subscription,
      resourceGroupName,
      workspaceName,
      name,
    });
  });

const program = (modelId: string) =>
  Effect.gen(function* () {
    const base = yield* baseProject();
    const marketplace = yield* Azure.MachineLearning.MarketplaceSubscription(
      "Model",
      {
        resourceGroup: base.group.resourceGroupName,
        workspace: base.workspace.workspaceName,
        modelId,
      },
    );
    return { ...base, marketplace };
  });

// Marketplace subscriptions purchase a third-party Azure Marketplace offer,
// which the free trial blocks. The subscription itself has no hourly
// charge (pay-per-token through a serverless endpoint); ~5 minutes.
test.provider.skipIf(!runPaidOnly)(
  "create, replace, and delete a marketplace subscription",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, marketplace } = yield* stack.deploy(
        program(llama),
      );
      const get = (name: string) =>
        getSubscription(group.resourceGroupName, workspace.workspaceName, name);
      expect(marketplace.status).toEqual("Subscribed");
      const observed = yield* get(marketplace.marketplaceSubscriptionName);
      expect(observed.properties.modelId).toEqual(llama);
      expect(observed.properties.provisioningState).toEqual("Succeeded");

      // Unchanged props converge without a new PUT.
      const same = yield* stack.deploy(program(llama));
      expect(same.marketplace.marketplaceSubscriptionId).toEqual(
        marketplace.marketplaceSubscriptionId,
      );

      // The model is immutable: changing it replaces the subscription.
      const replaced = yield* stack.deploy(program(mistral));
      expect(replaced.marketplace.modelId).toEqual(mistral);
      expect(
        (yield* get(replaced.marketplace.marketplaceSubscriptionName))
          .properties.modelId,
      ).toEqual(mistral);

      yield* stack.destroy();
      expect(
        yield* waitGone(get(replaced.marketplace.marketplaceSubscriptionName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe: third-party catalog models are not offered to the free
// trial, so the subscription is rejected with the typed error ("The
// requested model ... is not available."; hub + project have no hourly
// charge; ~3-5 minutes).
test.provider(
  "a marketplace subscription on the free trial is rejected",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group, workspace } = yield* stack.deploy(baseProject());
      const error = yield* ml
        .MarketplaceSubscriptionsCreateOrUpdate({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          workspaceName: workspace.workspaceName,
          name: "probe-marketplace",
          properties: { modelId: llama },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("MachineLearningModelNotAvailable");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
