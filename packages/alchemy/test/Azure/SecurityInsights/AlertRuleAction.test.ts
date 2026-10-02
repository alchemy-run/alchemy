import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as logic from "@distilled.cloud/azure/logic";
import * as securityinsights from "@distilled.cloud/azure/securityinsights";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { pollGone, sentinelWorkspace, tags } from "./sentinel.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getAction = (
  resourceGroupName: string,
  workspaceName: string,
  ruleId: string,
  actionId: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* securityinsights.GetAction({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      ruleId,
      actionId,
    });
  });

const actionGone = (rg: string, ws: string, ruleId: string, id: string) =>
  pollGone(
    getAction(rg, ws, ruleId, id).pipe(
      Effect.as("found" as const),
      Effect.catchTag(
        ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
        () => Effect.succeed("gone" as const),
      ),
    ),
  );

const callbackUrl = (resourceGroupName: string, workflowName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const url = yield* logic.ListWorkflowTriggerCallbackUrl({
      subscriptionId,
      resourceGroupName,
      workflowName,
      triggerName: "manual",
    });
    return url.value!;
  });

const definition = {
  $schema:
    "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
  contentVersion: "1.0.0.0",
  triggers: {
    manual: { type: "Request", kind: "Http", inputs: { schema: {} } },
  },
  actions: {
    reply: { type: "Response", kind: "Http", inputs: { statusCode: 200 } },
  },
};

const program = (opts?: {
  playbook: "A" | "B";
  triggerUri: string;
  actionId?: string;
}) =>
  Effect.gen(function* () {
    const { group, logs, sentinel } = yield* sentinelWorkspace;
    const rule = yield* Azure.SecurityInsights.AlertRule("Rule", {
      resourceGroup: sentinel.resourceGroup,
      workspace: sentinel.workspace,
      displayName: "Alchemy playbook rule",
      severity: "Low",
      query: "Heartbeat | take 1",
      queryFrequency: "PT1H",
      queryPeriod: "PT1H",
    });
    const playbookA = yield* Azure.Logic.Workflow("PlaybookA", {
      resourceGroup: group.resourceGroupName,
      definition,
    });
    const playbookB = yield* Azure.Logic.Workflow("PlaybookB", {
      resourceGroup: group.resourceGroupName,
      definition,
    });
    const action = opts
      ? yield* Azure.SecurityInsights.AlertRuleAction("Action", {
          resourceGroup: rule.resourceGroup,
          workspace: rule.workspace,
          ruleId: rule.ruleId,
          actionId: opts.actionId,
          logicAppResourceId:
            opts.playbook === "A" ? playbookA.workflowId : playbookB.workflowId,
          triggerUri: Redacted.make(opts.triggerUri),
        })
      : undefined;
    return { group, logs, rule, playbookA, playbookB, action };
  });

const REPLACEMENT_ID = "9c4e2d1a-7b3f-4a6e-8d2c-5f1e0b9a7c34";

// Microsoft retired the alert rule actions API: every call (GET included)
// returns HTTP 400 "Rules Actions API has been deprecated and is no longer
// available". This probe pins the typed error.
test.provider(
  "alert rule actions are rejected as deprecated",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const bare = yield* stack.deploy(program());
      const rg = bare.group.resourceGroupName;
      const ws = bare.logs.workspaceName;
      const uri = yield* callbackUrl(rg, bare.playbookA.workflowName);
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      const error = yield* securityinsights
        .ActionsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: rg,
          workspaceName: ws,
          ruleId: bare.rule.ruleId,
          actionId: REPLACEMENT_ID,
          properties: {
            logicAppResourceId: bare.playbookA.workflowId,
            triggerUri: uri,
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("SentinelRuleActionsDeprecated");
      yield* stack.destroy();
    }),
  { tags, timeout: 900_000 },
);

// Full lifecycle, kept for workspaces/clouds where the API still answers
// (AZURE_TEST_SENTINEL_RULE_ACTIONS=1). Sentinel trial + two idle
// consumption Logic Apps: ~$0 per run, ~4 minutes.
test.provider.skipIf(!process.env.AZURE_TEST_SENTINEL_RULE_ACTIONS)(
  "create, update, replace, and delete a Sentinel alert rule action",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const bare = yield* stack.deploy(program());
      const rg = bare.group.resourceGroupName;
      const ws = bare.logs.workspaceName;
      const ruleId = bare.rule.ruleId;
      const uriA = yield* callbackUrl(rg, bare.playbookA.workflowName);
      const uriB = yield* callbackUrl(rg, bare.playbookB.workflowName);

      const created = yield* stack.deploy(
        program({ playbook: "A", triggerUri: uriA }),
      );
      const actionId = created.action!.actionId;
      const observed = yield* getAction(rg, ws, ruleId, actionId);
      expect(observed.properties?.logicAppResourceId?.toLowerCase()).toEqual(
        bare.playbookA.workflowId.toLowerCase(),
      );

      // Pointing at another playbook updates the action in place.
      const updated = yield* stack.deploy(
        program({ playbook: "B", triggerUri: uriB }),
      );
      expect(updated.action!.actionId).toEqual(actionId);
      const after = yield* getAction(rg, ws, ruleId, actionId);
      expect(after.properties?.logicAppResourceId?.toLowerCase()).toEqual(
        bare.playbookB.workflowId.toLowerCase(),
      );

      const replaced = yield* stack.deploy(
        program({ playbook: "B", triggerUri: uriB, actionId: REPLACEMENT_ID }),
      );
      expect(replaced.action!.actionId).toEqual(REPLACEMENT_ID);
      expect(yield* actionGone(rg, ws, ruleId, actionId)).toEqual("gone");

      yield* stack.destroy();
      expect(yield* actionGone(rg, ws, ruleId, REPLACEMENT_ID)).toEqual(
        "gone",
      );
    }),
  { tags, timeout: 900_000 },
);
