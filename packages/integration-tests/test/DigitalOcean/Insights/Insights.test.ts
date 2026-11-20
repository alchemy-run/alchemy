import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import {
  getInsightAlertRule,
  getInsightDashboard,
  getInsightNotificationChannel,
} from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import { accountEmail, isGone, logLevel } from "../support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:insights", "live"];

const resources = (warning: number, title: string) =>
  Effect.gen(function* () {
    const email = yield* accountEmail;
    const channel = yield* DigitalOcean.Insights.NotificationChannel("OnCall", {
      email: { to: email },
    });
    const rule = yield* DigitalOcean.Insights.AlertRule("HighCpu", {
      metric: "do.droplets.cpu_utilization",
      tags: ["alchemy-test-insights"],
      thresholds: { operator: "THRESHOLD_OPERATOR_GREATER_THAN", warning, critical: 95 },
      notify: [{ channelId: channel.channelId }],
    });
    const dashboard = yield* DigitalOcean.Insights.Dashboard("Overview", {
      definition: {
        kind: "Dashboard",
        metadata: { name: "alchemy-overview" },
        spec: { display: { name: title }, panels: {}, layouts: [] },
      },
    });
    return {
      channelId: channel.channelId,
      ruleId: rule.alertRuleId,
      dashboardId: dashboard.dashboardId,
    };
  });

test.provider(
  "notification channel, alert rule and dashboard: create, update in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(resources(80, "Overview"));
      const rule = yield* getInsightAlertRule({ id: created.ruleId });
      expect(rule.alert_rule.spec.notification_channels?.[0]?.notification_channel_id).toEqual(
        created.channelId,
      );
      expect(rule.alert_rule.status).toEqual("ALERT_RULE_STATUS_ACTIVE");

      const updated = yield* stack.deploy(resources(70, "Overview v2"));
      expect(updated).toEqual(created);
      const after = yield* getInsightAlertRule({ id: created.ruleId });
      expect((after.alert_rule.spec.thresholds as { warning?: number }).warning).toEqual(70);
      const dashboard = yield* getInsightDashboard({ uuid: created.dashboardId });
      expect(dashboard.dashboard.spec).toContain("Overview v2");

      const plan = yield* stack.plan(resources(70, "Overview v2"));
      expect(Object.values(plan.resources).filter((node) => node.action !== "noop")).toEqual([]);

      yield* stack.destroy();
      expect(yield* isGone(getInsightAlertRule({ id: created.ruleId }))).toBe(true);
      expect(yield* isGone(getInsightNotificationChannel({ id: created.channelId }))).toBe(true);
      expect(yield* isGone(getInsightDashboard({ uuid: created.dashboardId }))).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS },
);
