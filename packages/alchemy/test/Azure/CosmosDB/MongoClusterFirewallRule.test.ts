import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as mongocluster from "@distilled.cloud/azure/mongocluster";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, waitGone } from "./helpers.ts";
import { clusterRef, mongoTags, testCluster } from "./mongo.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: { name: string; endIpAddress: string }) =>
  Effect.gen(function* () {
    const { group, cluster } = yield* testCluster();
    const rule = yield* Azure.CosmosDB.MongoClusterFirewallRule("Office", {
      resourceGroup: group.resourceGroupName,
      cluster: cluster.mongoClusterName,
      name: props.name,
      startIpAddress: "203.0.113.1",
      endIpAddress: props.endIpAddress,
    });
    return { group, cluster, rule };
  });

const getRule = (
  resourceGroupName: string,
  mongoClusterName: string,
  firewallRuleName: string,
) =>
  Effect.flatMap(clusterRef(resourceGroupName, mongoClusterName), (ref) =>
    mongocluster.GetFirewallRule({ ...ref, firewallRuleName }),
  );

// One M10 cluster (≈ $0.10/h, 7-25 min to create and delete) — a few cents.
// Cluster provisioning regularly exceeds 10 minutes, so this runs only
// with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, replace, and delete a mongo cluster firewall rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, cluster, rule } = yield* stack.deploy(
        program({ name: "office", endIpAddress: "203.0.113.1" }),
      );
      expect(rule.firewallRuleName).toEqual("office");
      const observed = yield* getRule(
        group.resourceGroupName,
        cluster.mongoClusterName,
        "office",
      );
      expect(observed.id).toEqual(rule.firewallRuleId);
      expect(observed.properties?.startIpAddress).toEqual("203.0.113.1");
      expect(observed.properties?.endIpAddress).toEqual("203.0.113.1");

      // The range is mutable in place.
      const updated = yield* stack.deploy(
        program({ name: "office", endIpAddress: "203.0.113.255" }),
      );
      expect(updated.rule.firewallRuleId).toEqual(rule.firewallRuleId);
      const reobserved = yield* getRule(
        group.resourceGroupName,
        cluster.mongoClusterName,
        "office",
      );
      expect(reobserved.properties?.endIpAddress).toEqual("203.0.113.255");

      // Renaming replaces the rule.
      const renamed = yield* stack.deploy(
        program({ name: "office-v2", endIpAddress: "203.0.113.255" }),
      );
      expect(renamed.rule.firewallRuleName).toEqual("office-v2");
      expect(
        (yield* getRule(
          group.resourceGroupName,
          cluster.mongoClusterName,
          "office-v2",
        )).properties?.endIpAddress,
      ).toEqual("203.0.113.255");
      expect(
        yield* waitGone(
          getRule(group.resourceGroupName, cluster.mongoClusterName, "office"),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getRule(
            group.resourceGroupName,
            cluster.mongoClusterName,
            "office-v2",
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags: mongoTags, timeout: 900_000 },
);
