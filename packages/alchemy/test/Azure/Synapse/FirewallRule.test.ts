import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as synapse from "@distilled.cloud/azure/synapse";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  lakeWorkspace,
  logLevel,
  untilGone,
  withWorkspaceSlot,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRule = (
  resourceGroupName: string,
  workspaceName: string,
  ruleName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* synapse.GetIpFirewallRule({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      ruleName,
    });
  });

const program = (props: { end: string; name?: string }) =>
  Effect.gen(function* () {
    const { group, workspace } = yield* lakeWorkspace();
    const rule = yield* Azure.Synapse.FirewallRule("Office", {
      resourceGroup: group.resourceGroupName,
      workspace: workspace.workspaceName,
      name: props.name,
      startIpAddress: "203.0.113.1",
      endIpAddress: props.end,
    });
    return { group, workspace, rule };
  });

// Workspace (free while idle) ~3-8 min; the rule itself takes seconds.
test.provider(
  "create, update, replace, and delete a synapse firewall rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, rule } = yield* stack.deploy(
        program({ end: "203.0.113.1" }),
      );
      const rg = group.resourceGroupName;
      const ws = workspace.workspaceName;
      expect(rule.endIpAddress).toEqual("203.0.113.1");
      const observed = yield* getRule(rg, ws, rule.ruleName);
      expect(observed.properties?.startIpAddress).toEqual("203.0.113.1");

      // In place: widen the range.
      const updated = yield* stack.deploy(program({ end: "203.0.113.50" }));
      expect(updated.rule.ruleId).toEqual(rule.ruleId);
      const reobserved = yield* getRule(rg, ws, rule.ruleName);
      expect(reobserved.properties?.endIpAddress).toEqual("203.0.113.50");

      // Replace: rename.
      const renamed = yield* stack.deploy(
        program({ end: "203.0.113.50", name: "office-renamed" }),
      );
      expect(renamed.rule.ruleName).toEqual("office-renamed");
      expect(yield* untilGone(getRule(rg, ws, rule.ruleName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* untilGone(getRule(rg, ws, "office-renamed"))).toEqual(
        "gone",
      );
    }).pipe(withWorkspaceSlot, logLevel),
  {
    tags: ["provider:azure", "provider:azure:synapse", "live"],
    timeout: 900_000,
  },
);
