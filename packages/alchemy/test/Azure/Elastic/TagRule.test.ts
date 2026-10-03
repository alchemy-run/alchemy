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

const getTagRule = (resourceGroupName: string, monitorName: string) =>
  Effect.gen(function* () {
    return yield* elastic.GetTagRule({
      subscriptionId: yield* subscription,
      resourceGroupName,
      monitorName,
      ruleSetName: "default",
    });
  });

const getMonitor = (resourceGroupName: string, monitorName: string) =>
  Effect.gen(function* () {
    return yield* elastic.GetMonitor({
      subscriptionId: yield* subscription,
      resourceGroupName,
      monitorName,
    });
  });

const program = (sendActivityLogs: boolean) =>
  Effect.gen(function* () {
    const { group, monitor } = yield* monitorStack;
    const rules = yield* Azure.Elastic.TagRule("Rules", {
      resourceGroup: group.resourceGroupName,
      monitor: monitor.monitorName,
      logRules: {
        sendSubscriptionLogs: true,
        sendActivityLogs,
        filteringTags: [{ name: "elastic", value: "true", action: "Include" }],
      },
    });
    return { group, monitor, rules };
  });

// Needs an Elastic monitor (Marketplace SaaS purchase + hosted deployment,
// ~$0.50-1/hour, ~5-15 minutes); the free trial cannot create one (see the
// Monitor probe). Run only with AZURE_TEST_PAID=1.
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete elastic tag rules",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, monitor, rules } = yield* stack.deploy(program(false));
      expect(rules.ruleSetName).toEqual("default");
      const observed = yield* getTagRule(
        group.resourceGroupName,
        monitor.monitorName,
      );
      expect(observed.properties?.logRules?.sendSubscriptionLogs).toEqual(true);
      expect(observed.properties?.logRules?.sendActivityLogs).toEqual(false);
      expect(observed.properties?.logRules?.filteringTags?.[0]?.name).toEqual(
        "elastic",
      );

      // In place: activity logs.
      yield* stack.deploy(program(true));
      const updated = yield* getTagRule(
        group.resourceGroupName,
        monitor.monitorName,
      );
      expect(updated.properties?.logRules?.sendActivityLogs).toEqual(true);

      yield* stack.destroy();
      expect(
        yield* waitGone(getMonitor(group.resourceGroupName, monitor.monitorName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
