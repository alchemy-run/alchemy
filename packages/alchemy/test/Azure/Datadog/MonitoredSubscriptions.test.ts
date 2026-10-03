import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as datadog from "@distilled.cloud/azure/datadog";
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

const getConfiguration = (resourceGroupName: string, monitorName: string) =>
  Effect.gen(function* () {
    return yield* datadog.GetMonitoredSubscription({
      subscriptionId: yield* subscription,
      resourceGroupName,
      monitorName,
      configurationName: "default",
    });
  });

/** A second subscription the deploying identity owns. */
const secondSubscription = process.env.AZURE_TEST_DATADOG_SECOND_SUBSCRIPTION;

const program = (subscriptionId: string, sendSubscriptionLogs: boolean) =>
  Effect.gen(function* () {
    const { group, monitor } = yield* monitorStack;
    const monitored = yield* Azure.Datadog.MonitoredSubscriptions("Monitored", {
      resourceGroup: group.resourceGroupName,
      monitor: monitor.monitorName,
      subscriptions: [
        { subscriptionId, tagRules: { logRules: { sendSubscriptionLogs } } },
      ],
    });
    return { group, monitor, monitored };
  });

// Needs a Datadog monitor (Marketplace SaaS purchase, ~3-10 minutes; the
// free trial cannot create one, see the Monitor probe) and a second
// subscription owned by the test identity. Run only with AZURE_TEST_PAID=1
// and AZURE_TEST_DATADOG_SECOND_SUBSCRIPTION.
test.provider.skipIf(!runPaidOnly || !secondSubscription)(
  "add, update, and remove datadog monitored subscriptions",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const target = secondSubscription!;

      const { group, monitor, monitored } = yield* stack.deploy(
        program(target, false),
      );
      expect(monitored.subscriptions.map((s) => s.subscriptionId)).toContain(
        target,
      );
      const observed = yield* getConfiguration(
        group.resourceGroupName,
        monitor.monitorName,
      );
      const entry = observed.properties?.monitoredSubscriptionList?.find(
        (s) => s.subscriptionId?.toLowerCase() === target.toLowerCase(),
      );
      expect(entry?.status).toEqual("Active");

      // In place: the subscription's tag rules.
      yield* stack.deploy(program(target, true));
      const updated = (yield* getConfiguration(
        group.resourceGroupName,
        monitor.monitorName,
      )).properties?.monitoredSubscriptionList?.find(
        (s) => s.subscriptionId?.toLowerCase() === target.toLowerCase(),
      );
      expect(updated?.tagRules?.logRules?.sendSubscriptionLogs).toEqual(true);

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getConfiguration(group.resourceGroupName, monitor.monitorName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
