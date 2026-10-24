import * as Azure from "@alchemy.run/azure";
import * as logic from "@distilled.cloud/azure/logic";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { freeAccount, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  name?: string;
  releaseCriteria: Azure.Logic.IntegrationAccountBatchReleaseCriteria;
  owner: string;
}) =>
  Effect.gen(function* () {
    // One Free account per region per subscription: this file owns westus.
    const { group, account } = yield* freeAccount("westus");
    const batch = yield* Azure.Logic.IntegrationAccountBatchConfiguration("Orders", {
      resourceGroup: group.resourceGroupName,
      integrationAccount: account.integrationAccountName,
      name: props.name,
      batchGroupName: "orders",
      releaseCriteria: props.releaseCriteria,
      metadata: { owner: props.owner },
    });
    return { group, account, batch };
  });

const getBatch = (rg: string, account: string, batchConfigurationName: string) =>
  Effect.gen(function* () {
    return yield* logic.GetIntegrationAccountBatchConfiguration({
      subscriptionId: yield* subscription,
      resourceGroupName: rg,
      integrationAccountName: account,
      batchConfigurationName,
    });
  });

// Free integration account: no cost, synchronous.
test.provider(
  "create, update, replace, and delete an integration account batch configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, batch } = yield* stack.deploy(
        program({ releaseCriteria: { messageCount: 10 }, owner: "a" }),
      );
      const rg = group.resourceGroupName;
      const ia = account.integrationAccountName;
      expect(batch.batchGroupName).toEqual("orders");
      expect(batch.metadata).toEqual({ owner: "a" });
      const observed = yield* getBatch(rg, ia, batch.batchConfigurationName);
      expect(observed.properties.batchGroupName).toEqual("orders");
      expect(observed.properties.releaseCriteria.messageCount).toEqual(10);
      const metadata = observed.properties.metadata as Record<string, unknown>;
      expect(metadata.owner).toEqual("a");
      expect(metadata["alchemy::id"]).toEqual("Orders");

      // In-place: release criteria and metadata.
      const updated = yield* stack.deploy(
        program({ releaseCriteria: { messageCount: 5, batchSize: 1_048_576 }, owner: "b" }),
      );
      expect(updated.batch.batchConfigurationId).toEqual(batch.batchConfigurationId);
      const reobserved = yield* getBatch(rg, ia, batch.batchConfigurationName);
      expect(reobserved.properties.releaseCriteria.messageCount).toEqual(5);
      expect(reobserved.properties.releaseCriteria.batchSize).toEqual(1_048_576);
      expect((reobserved.properties.metadata as Record<string, unknown>).owner).toEqual("b");

      // Replacement: a new name.
      const replaced = yield* stack.deploy(
        program({
          name: "ordersv2",
          releaseCriteria: { messageCount: 5, batchSize: 1_048_576 },
          owner: "b",
        }),
      );
      expect(replaced.batch.batchConfigurationName).toEqual("ordersv2");
      expect(yield* waitGone(getBatch(rg, ia, batch.batchConfigurationName))).toEqual("gone");
      const replacedObserved = yield* getBatch(rg, ia, "ordersv2");
      expect(replacedObserved.properties.releaseCriteria.messageCount).toEqual(5);

      yield* stack.destroy();
      expect(yield* waitGone(getBatch(rg, ia, "ordersv2"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
