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

const getTagRule = (resourceGroupName: string, monitorName: string) =>
  Effect.gen(function* () {
    return yield* datadog.GetTagRule({
      subscriptionId: yield* subscription,
      resourceGroupName,
      monitorName,
      ruleSetName: "default",
    });
  });

const program = (props: { sendResourceLogs: boolean; automuting: boolean }) =>
  Effect.gen(function* () {
    const { group, monitor } = yield* monitorStack;
    const rules = yield* Azure.Datadog.TagRule("Rules", {
      resourceGroup: group.resourceGroupName,
      monitor: monitor.monitorName,
      logRules: {
        sendSubscriptionLogs: true,
        sendResourceLogs: props.sendResourceLogs,
        filteringTags: [{ name: "datadog", value: "true", action: "Include" }],
      },
      metricRules: {
        filteringTags: [{ name: "env", value: "dev", action: "Exclude" }],
      },
      automuting: props.automuting,
    });
    return { group, monitor, rules };
  });

// Needs a Datadog monitor (Marketplace SaaS purchase, ~3-10 minutes); the
// free trial cannot create one (see the Monitor probe). Run only with
// AZURE_TEST_PAID=1.
test.provider.skipIf(!runPaidOnly)(
  "create, update, and reset datadog tag rules",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, monitor, rules } = yield* stack.deploy(
        program({ sendResourceLogs: false, automuting: false }),
      );
      expect(rules.ruleSetName).toEqual("default");
      const observed = yield* getTagRule(
        group.resourceGroupName,
        monitor.monitorName,
      );
      expect(observed.properties?.logRules?.sendSubscriptionLogs).toEqual(true);
      expect(observed.properties?.logRules?.sendResourceLogs).toEqual(false);
      expect(observed.properties?.logRules?.filteringTags?.[0]?.name).toEqual(
        "datadog",
      );

      // In place: resource logs and automuting.
      yield* stack.deploy(
        program({ sendResourceLogs: true, automuting: true }),
      );
      const updated = yield* getTagRule(
        group.resourceGroupName,
        monitor.monitorName,
      );
      expect(updated.properties?.logRules?.sendResourceLogs).toEqual(true);
      expect(updated.properties?.automuting).toEqual(true);

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getTagRule(group.resourceGroupName, monitor.monitorName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
