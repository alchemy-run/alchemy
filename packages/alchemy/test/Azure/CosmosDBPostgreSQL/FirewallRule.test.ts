import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as postgresqlhsc from "@distilled.cloud/azure/postgresqlhsc";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  clusterRef,
  existingCluster,
  logLevel,
  tags,
  untilGone,
} from "./cluster.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRule = (firewallRuleName: string) =>
  Effect.gen(function* () {
    const ref = yield* clusterRef(
      existingCluster!.resourceGroup,
      existingCluster!.cluster,
    );
    return yield* postgresqlhsc.GetFirewallRule({ ...ref, firewallRuleName });
  });

const program = (props: { name: string; endIpAddress: string }) =>
  Azure.CosmosDBPostgreSQL.FirewallRule("Office", {
    resourceGroup: existingCluster!.resourceGroup,
    cluster: existingCluster!.cluster,
    name: props.name,
    startIpAddress: "203.0.113.1",
    endIpAddress: props.endIpAddress,
  });

// New clusters cannot be provisioned (service retirement); runs against an
// existing cluster from AZURE_COSMOS_PG_CLUSTER. Rules are free.
test.provider.skipIf(existingCluster === undefined)(
  "create, update, replace, and delete a firewall rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rule = yield* stack.deploy(
        program({ name: "alchemy-office", endIpAddress: "203.0.113.1" }),
      );
      expect(rule.firewallRuleName).toEqual("alchemy-office");
      const observed = yield* getRule("alchemy-office");
      expect(observed.properties.startIpAddress).toEqual("203.0.113.1");
      expect(observed.properties.endIpAddress).toEqual("203.0.113.1");

      // The range is mutable in place.
      const updated = yield* stack.deploy(
        program({ name: "alchemy-office", endIpAddress: "203.0.113.255" }),
      );
      expect(updated.firewallRuleId).toEqual(rule.firewallRuleId);
      expect(
        (yield* getRule("alchemy-office")).properties.endIpAddress,
      ).toEqual("203.0.113.255");

      // Renaming replaces the rule.
      const renamed = yield* stack.deploy(
        program({ name: "alchemy-office-v2", endIpAddress: "203.0.113.255" }),
      );
      expect(renamed.firewallRuleName).toEqual("alchemy-office-v2");
      expect(yield* untilGone(getRule("alchemy-office"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* untilGone(getRule("alchemy-office-v2"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
