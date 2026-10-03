import * as Azure from "@/Azure";
import { ensureRegistered } from "@/Azure/Arm";
import * as Test from "@/Test/Alchemy";
import * as alertsmanagement from "@distilled.cloud/azure/alertsmanagement";
import { Credentials } from "@distilled.cloud/azure/Credentials";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const LOCATION = "eastus";
const COMPONENT_NAME = "alchemy-sdar-appinsights";
const ACTION_GROUP_NAME = "alchemy-sdar-actions";

const getRule = (resourceGroupName: string, alertRuleName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* alertsmanagement.GetSmartDetectorAlertRule({
      subscriptionId,
      resourceGroupName,
      alertRuleName,
    });
  });

const ruleGone = (resourceGroupName: string, ruleName: string) =>
  getRule(resourceGroupName, ruleName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 20,
    }),
  );

/**
 * Application Insights components and action groups are prerequisites from
 * services Alchemy does not implement yet, and distilled has no SDK for
 * them; create them out of band in the stack's resource group with raw ARM
 * calls.
 */
const armRequest = (
  method: "GET" | "PUT" | "DELETE",
  path: string,
  apiVersion: string,
  body?: unknown,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const credentials = yield* yield* Credentials;
    const client = yield* HttpClient.HttpClient;
    const url = `${credentials.apiBaseUrl}/subscriptions/${subscriptionId}${path}?api-version=${apiVersion}`;
    let request = HttpClientRequest.make(method)(url).pipe(
      HttpClientRequest.bearerToken(Redacted.value(credentials.bearerToken)),
    );
    if (body !== undefined) {
      request = request.pipe(HttpClientRequest.bodyJsonUnsafe(body));
    }
    const response = yield* client.execute(request);
    const text = yield* response.text;
    return {
      status: response.status,
      text,
      json:
        text.length > 0
          ? (JSON.parse(text) as {
              id?: string;
              properties?: { provisioningState?: string };
            })
          : undefined,
    };
  });

const componentPath = (rg: string) =>
  `/resourceGroups/${rg}/providers/Microsoft.Insights/components/${COMPONENT_NAME}`;
const actionGroupPath = (rg: string) =>
  `/resourceGroups/${rg}/providers/Microsoft.Insights/actionGroups/${ACTION_GROUP_NAME}`;

const ensurePrerequisites = (rg: string, logAnalyticsId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    yield* ensureRegistered(subscriptionId, "Microsoft.Insights");
    const component = yield* armRequest("PUT", componentPath(rg), "2020-02-02", {
      location: LOCATION,
      kind: "web",
      properties: {
        Application_Type: "web",
        WorkspaceResourceId: logAnalyticsId,
      },
    });
    expect(`${component.status} ${component.text}`).toMatch(/^2\d\d /);
    const ready = yield* armRequest("GET", componentPath(rg), "2020-02-02").pipe(
      Effect.repeat({
        schedule: Schedule.spaced("3 seconds"),
        until: (res) =>
          res.json?.properties?.provisioningState === "Succeeded",
        times: 40,
      }),
    );
    const actionGroup = yield* armRequest(
      "PUT",
      actionGroupPath(rg),
      "2023-01-01",
      {
        location: "global",
        properties: { groupShortName: "alchemy", enabled: true },
      },
    );
    expect(`${actionGroup.status} ${actionGroup.text}`).toMatch(/^2\d\d /);
    return { componentId: ready.json!.id!, actionGroupId: actionGroup.json!.id! };
  });

const deletePrerequisites = (rg: string) =>
  Effect.gen(function* () {
    yield* armRequest("DELETE", actionGroupPath(rg), "2023-01-01");
    yield* armRequest("DELETE", componentPath(rg), "2020-02-02");
    const statuses = yield* Effect.all([
      armRequest("GET", actionGroupPath(rg), "2023-01-01"),
      armRequest("GET", componentPath(rg), "2020-02-02"),
    ]).pipe(
      Effect.map((responses) => responses.map((res) => res.status)),
      Effect.repeat({
        schedule: Schedule.spaced("3 seconds"),
        until: (codes) => codes.every((code) => code === 404),
        times: 20,
      }),
    );
    return statuses.every((code) => code === 404) ? "gone" : "found";
  });

interface RuleProps {
  name?: string;
  componentId: string;
  actionGroupId: string;
  severity: Azure.Monitor.SmartDetectorSeverity;
  state: "Enabled" | "Disabled";
  description: string;
  tags: Record<string, string>;
}

const program = (rule?: RuleProps) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const logs = yield* Azure.LogAnalytics.Workspace("Logs", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
    });
    if (rule === undefined) return { group, logs };
    const detector = yield* Azure.Monitor.SmartDetectorAlertRule("Failures", {
      resourceGroup: group.resourceGroupName,
      name: rule.name,
      detector: { id: "FailureAnomaliesDetector" },
      scopes: [rule.componentId],
      severity: rule.severity,
      state: rule.state,
      frequency: "PT1M",
      description: rule.description,
      actionGroups: { groupIds: [rule.actionGroupId] },
      tags: rule.tags,
    });
    return { group, logs, detector };
  });

// Free: smart detection rules carry no charge, the action group has no
// receivers, and the workspace-based App Insights component bills only
// ingestion (none). ~3 minutes.
test.provider(
  "create, update, replace, and delete a smart detector alert rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const base = yield* stack.deploy(program());
      const rg = base.group.resourceGroupName;
      const { componentId, actionGroupId } = yield* ensurePrerequisites(
        rg,
        base.logs.workspaceId,
      );
      const props = {
        componentId,
        actionGroupId,
        severity: "Sev3",
        state: "Enabled",
        description: "first",
        tags: { env: "test" },
      } satisfies RuleProps;

      const created = yield* stack.deploy(program(props));
      const first = created.detector!;
      expect(first.ruleId).toMatch(/smartDetectorAlertRules/i);
      expect(first.detectorId).toEqual("FailureAnomaliesDetector");
      const observed = yield* getRule(rg, first.ruleName);
      expect(observed.properties?.severity).toEqual("Sev3");
      expect(observed.properties?.state).toEqual("Enabled");
      expect(observed.properties?.description).toEqual("first");
      expect(observed.properties?.scope[0]?.toLowerCase()).toEqual(
        componentId.toLowerCase(),
      );
      expect(
        observed.properties?.actionGroups.groupIds[0]?.toLowerCase(),
      ).toEqual(actionGroupId.toLowerCase());
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Failures");

      // In-place update: severity, state, description, tags.
      const updated = yield* stack.deploy(
        program({
          ...props,
          severity: "Sev1",
          state: "Disabled",
          description: "second",
          tags: { env: "prod" },
        }),
      );
      expect(updated.detector!.ruleId).toEqual(first.ruleId);
      const reobserved = yield* getRule(rg, first.ruleName);
      expect(reobserved.properties?.severity).toEqual("Sev1");
      expect(reobserved.properties?.state).toEqual("Disabled");
      expect(reobserved.properties?.description).toEqual("second");
      expect(reobserved.tags?.env).toEqual("prod");

      // Renaming replaces the rule.
      const renamed = yield* stack.deploy(
        program({ ...props, name: "alchemy-sdar-renamed" }),
      );
      expect(renamed.detector!.ruleName).toEqual("alchemy-sdar-renamed");
      const replaced = yield* getRule(rg, "alchemy-sdar-renamed");
      expect(replaced.properties?.severity).toEqual("Sev3");
      expect(yield* ruleGone(rg, first.ruleName)).toEqual("gone");

      // Removing the rule deletes it.
      yield* stack.deploy(program());
      expect(yield* ruleGone(rg, "alchemy-sdar-renamed")).toEqual("gone");

      expect(yield* deletePrerequisites(rg)).toEqual("gone");
      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:monitor", "live"],
    timeout: 900_000,
  },
);
