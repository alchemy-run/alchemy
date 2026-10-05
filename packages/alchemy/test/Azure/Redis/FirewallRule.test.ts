import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as redis from "@distilled.cloud/azure/redis";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRule = (resourceGroupName: string, cacheName: string, ruleName: string) =>
  Effect.gen(function* () {
    return yield* redis.GetFirewallRule({
      subscriptionId: yield* subscription,
      resourceGroupName,
      cacheName,
      ruleName,
    });
  });

const program = (props: { ruleName?: string; endIP: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const cache = yield* Azure.Redis.Cache("Cache", {
      resourceGroup: group.resourceGroupName,
      sku: "Basic",
      capacity: 0,
    });
    const rule = yield* Azure.Redis.FirewallRule("Rule", {
      resourceGroup: group.resourceGroupName,
      cache: cache.cacheName,
      name: props.ruleName,
      startIP: "203.0.113.1",
      endIP: props.endIP,
    });
    return { group, cache, rule };
  });

// Needs a Basic C0 cache (~$0.02/hour): cents per run, but 15-20 minutes
// to provision the cache.
test.provider.skipIf(!runExpensive)(
  "create, update, replace, and delete a redis firewall rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, cache, rule } = yield* stack.deploy(
        program({ endIP: "203.0.113.10" }),
      );
      expect(rule.ruleName).toMatch(/^[a-z0-9]+$/);
      const observed = yield* getRule(
        group.resourceGroupName,
        cache.cacheName,
        rule.ruleName,
      );
      expect(observed.properties.startIP).toEqual("203.0.113.1");
      expect(observed.properties.endIP).toEqual("203.0.113.10");

      // In-place: widen the range.
      const updated = yield* stack.deploy(program({ endIP: "203.0.113.20" }));
      expect(updated.rule.ruleId).toEqual(rule.ruleId);
      expect(updated.rule.endIP).toEqual("203.0.113.20");
      const reobserved = yield* getRule(
        group.resourceGroupName,
        cache.cacheName,
        rule.ruleName,
      );
      expect(reobserved.properties.endIP).toEqual("203.0.113.20");

      // Replace: rename the rule.
      const renamed = yield* stack.deploy(
        program({ ruleName: "office_range", endIP: "203.0.113.20" }),
      );
      expect(renamed.rule.ruleName).toEqual("office_range");
      expect(
        (yield* getRule(group.resourceGroupName, cache.cacheName, "office_range"))
          .properties.endIP,
      ).toEqual("203.0.113.20");
      expect(
        yield* waitGone(
          getRule(group.resourceGroupName, cache.cacheName, rule.ruleName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getRule(group.resourceGroupName, cache.cacheName, "office_range"),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 3_600_000 },
);
