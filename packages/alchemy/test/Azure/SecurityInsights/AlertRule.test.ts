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
  ruleId: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* securityinsights.GetAlertRule({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      ruleId,
    });
  });

const ruleGone = (rg: string, ws: string, ruleId: string) =>
  pollGone(
    getRule(rg, ws, ruleId).pipe(
      Effect.as("found" as const),
      Effect.catchTag(
        ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
        () => Effect.succeed("gone" as const),
      ),
    ),
  );

const program = (opts: {
  severity: "High" | "Low";
  query: string;
  incidents?: boolean;
}) =>
  Effect.gen(function* () {
    const { group, logs, sentinel } = yield* sentinelWorkspace;
    const rule = opts.incidents
      ? yield* Azure.SecurityInsights.AlertRule("Rule", {
          resourceGroup: sentinel.resourceGroup,
          workspace: sentinel.workspace,
          kind: "MicrosoftSecurityIncidentCreation",
          displayName: "Alchemy Defender incidents",
          description: "Raised by the Alchemy test suite",
          productFilter: "Azure Security Center",
          severitiesFilter: [opts.severity],
        })
      : yield* Azure.SecurityInsights.AlertRule("Rule", {
          resourceGroup: sentinel.resourceGroup,
          workspace: sentinel.workspace,
          displayName: "Alchemy heartbeat rule",
          description: "Raised by the Alchemy test suite",
          severity: opts.severity,
          query: opts.query,
          queryFrequency: "PT1H",
          queryPeriod: "PT1H",
          tactics: ["Impact"],
        });
    return { group, logs, rule };
  });

// Sentinel trial + empty workspace: ~$0 per run, ~3 minutes.
test.provider(
  "create, update, replace, and delete a Sentinel analytics rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ severity: "Low", query: "Heartbeat | take 1" }),
      );
      const rg = created.group.resourceGroupName;
      const ws = created.logs.workspaceName;
      const ruleId = created.rule.ruleId;
      expect(created.rule.kind).toEqual("Scheduled");
      const observed = yield* getRule(rg, ws, ruleId);
      const props = observed.properties as Record<string, unknown>;
      expect(props.severity).toEqual("Low");
      expect(props.query).toEqual("Heartbeat | take 1");
      expect(String(props.description)).toContain("[alchemy ");

      // In-place update of mutable properties.
      const updated = yield* stack.deploy(
        program({ severity: "High", query: "Heartbeat | take 2" }),
      );
      expect(updated.rule.ruleId).toEqual(ruleId);
      const after = (yield* getRule(rg, ws, ruleId)).properties as Record<
        string,
        unknown
      >;
      expect(after.severity).toEqual("High");
      expect(after.query).toEqual("Heartbeat | take 2");

      // Changing the kind replaces the rule.
      const replaced = yield* stack.deploy(
        program({ severity: "High", query: "", incidents: true }),
      );
      expect(replaced.rule.kind).toEqual("MicrosoftSecurityIncidentCreation");
      expect(replaced.rule.ruleId).not.toEqual(ruleId);
      expect(yield* ruleGone(rg, ws, ruleId)).toEqual("gone");
      const incidents = yield* getRule(rg, ws, replaced.rule.ruleId);
      expect(incidents.kind).toEqual("MicrosoftSecurityIncidentCreation");
      expect(
        (incidents.properties as Record<string, unknown>).productFilter,
      ).toEqual("Azure Security Center");

      yield* stack.destroy();
      expect(yield* ruleGone(rg, ws, replaced.rule.ruleId)).toEqual("gone");
    }),
  { tags, timeout: 900_000 },
);
