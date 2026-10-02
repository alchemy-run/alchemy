import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as securityinsights from "@distilled.cloud/azure/securityinsights";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { pollGone, sentinelWorkspace, tags } from "./sentinel.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRule = (
  resourceGroupName: string,
  workspaceName: string,
  automationRuleId: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* securityinsights.GetAutomationRule({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      automationRuleId,
    });
  });

const program = (displayName: string, order: number, ruleId?: string) =>
  Effect.gen(function* () {
    const { group, logs, sentinel } = yield* sentinelWorkspace;
    const rule = yield* Azure.SecurityInsights.AutomationRule("Rule", {
      resourceGroup: sentinel.resourceGroup,
      workspace: sentinel.workspace,
      automationRuleId: ruleId,
      displayName,
      order,
      triggeringLogic: {
        isEnabled: true,
        triggersOn: "Incidents",
        triggersWhen: "Created",
      },
      actions: [
        {
          order: 1,
          actionType: "ModifyProperties",
          actionConfiguration: { severity: "High" },
        },
      ],
    });
    return { group, logs, rule };
  });

const REPLACEMENT_ID = "6b1d6a8e-2f43-4c1a-9d1e-0a5c3b7e9f21";

// Sentinel trial + empty workspace: ~$0 per run, ~3 minutes.
test.provider(
  "create, update, replace, and delete a Sentinel automation rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program("Raise severity", 1));
      const rg = created.group.resourceGroupName;
      const ws = created.logs.workspaceName;
      const ruleId = created.rule.automationRuleId;
      const observed = yield* getRule(rg, ws, ruleId);
      expect(observed.properties.displayName).toEqual("Raise severity");
      expect(observed.properties.order).toEqual(1);

      const updated = yield* stack.deploy(program("Raise severity v2", 2));
      expect(updated.rule.automationRuleId).toEqual(ruleId);
      const after = yield* getRule(rg, ws, ruleId);
      expect(after.properties.displayName).toEqual("Raise severity v2");
      expect(after.properties.order).toEqual(2);

      const replaced = yield* stack.deploy(
        program("Raise severity v2", 2, REPLACEMENT_ID),
      );
      expect(replaced.rule.automationRuleId).toEqual(REPLACEMENT_ID);
      const oldGone = yield* pollGone(
        getRule(rg, ws, ruleId).pipe(
          Effect.as("found" as const),
          Effect.catchTag(
            ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
            () => Effect.succeed("gone" as const),
          ),
        ),
      );
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();
      const gone = yield* pollGone(
        getRule(rg, ws, REPLACEMENT_ID).pipe(
          Effect.as("found" as const),
          Effect.catchTag(
            ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
            () => Effect.succeed("gone" as const),
          ),
        ),
      );
      expect(gone).toEqual("gone");
    }),
  { tags, timeout: 900_000 },
);
