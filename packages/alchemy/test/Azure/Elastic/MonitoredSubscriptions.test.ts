import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as elastic from "@distilled.cloud/azure/elastic";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  logLevel,
  monitorStack,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getMonitor = (resourceGroupName: string, monitorName: string) =>
  Effect.gen(function* () {
    return yield* elastic.GetMonitor({
      subscriptionId: yield* subscription,
      resourceGroupName,
      monitorName,
    });
  });

const getConfiguration = (resourceGroupName: string, monitorName: string) =>
  Effect.gen(function* () {
    return yield* elastic.GetMonitoredSubscription({
      subscriptionId: yield* subscription,
      resourceGroupName,
      monitorName,
      configurationName: "default",
    });
  });

/** A second subscription the deploying identity owns. */
const secondSubscription = process.env.AZURE_TEST_ELASTIC_SECOND_SUBSCRIPTION;

const program = (subscriptionId: string, sendSubscriptionLogs: boolean) =>
  Effect.gen(function* () {
    const { group, monitor } = yield* monitorStack;
    const monitored = yield* Azure.Elastic.MonitoredSubscriptions("Monitored", {
      resourceGroup: group.resourceGroupName,
      monitor: monitor.monitorName,
      subscriptions: [{ subscriptionId, logRules: { sendSubscriptionLogs } }],
    });
    return { group, monitor, monitored };
  });

// Needs an Elastic monitor (Marketplace SaaS purchase + hosted deployment,
// ~$0.50-1/hour, ~10-50 minutes; the free trial cannot create one, see the
// Monitor probe) and a second subscription owned by the test identity. Run
// only with AZURE_TEST_PAID=1 and AZURE_TEST_ELASTIC_SECOND_SUBSCRIPTION.
test.provider.skipIf(!runPaidOnly || !secondSubscription)(
  "add, update, and remove elastic monitored subscriptions",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const target = secondSubscription!;
      const find = (
        config: elastic.GetMonitoredSubscriptionResponse,
      ) =>
        config.properties?.monitoredSubscriptionList?.find(
          (s) => s.subscriptionId.toLowerCase() === target.toLowerCase(),
        );

      const { group, monitor, monitored } = yield* stack.deploy(
        program(target, false),
      );
      expect(monitored.subscriptions.map((s) => s.subscriptionId)).toContain(
        target,
      );
      const observed = find(
        yield* getConfiguration(group.resourceGroupName, monitor.monitorName),
      );
      expect(observed?.status).toEqual("Active");

      // In place: the subscription's log rules.
      yield* stack.deploy(program(target, true));
      const updated = find(
        yield* getConfiguration(group.resourceGroupName, monitor.monitorName),
      );
      expect(updated?.tagRules?.logRules?.sendSubscriptionLogs).toEqual(true);

      yield* stack.destroy();
      expect(
        yield* waitGone(getMonitor(group.resourceGroupName, monitor.monitorName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 5_400_000 },
);
