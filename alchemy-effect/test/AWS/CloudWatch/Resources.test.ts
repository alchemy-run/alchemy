import * as AWS from "@/AWS";
import { destroy } from "@/Destroy";
import * as Output from "@/Output";
import { test } from "@/Test/Vitest";
import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const firehoseArn = process.env.TEST_CLOUDWATCH_METRIC_STREAM_FIREHOSE_ARN;
const metricStreamRoleArn = process.env.TEST_CLOUDWATCH_METRIC_STREAM_ROLE_ARN;

test(
  "create, update, delete dashboard",
  { timeout: 180_000 },
  Effect.gen(function* () {
    yield* destroy();

    const dashboard = yield* test.deploy(
      Effect.gen(function* () {
        return yield* AWS.CloudWatch.Dashboard("ManagedDashboard", {
          DashboardBody: { widgets: [] },
          tags: {
            fixture: "cloudwatch-resource-test",
          },
        });
      }),
    );

    const initial = yield* cloudwatch.getDashboard({
      DashboardName: dashboard.dashboardName,
    });
    expect(initial.DashboardBody).toContain("widgets");

    const updated = yield* test.deploy(
      Effect.gen(function* () {
        return yield* AWS.CloudWatch.Dashboard("ManagedDashboard", {
          DashboardBody: {
            widgets: [
              {
                type: "text",
                x: 0,
                y: 0,
                width: 6,
                height: 3,
                properties: { markdown: "updated" },
              },
            ],
          },
          tags: {
            fixture: "cloudwatch-resource-test",
            updated: "true",
          },
        });
      }),
    );

    const afterUpdate = yield* cloudwatch.getDashboard({
      DashboardName: updated.dashboardName,
    });
    expect(afterUpdate.DashboardBody).toContain("updated");

    const tags = yield* cloudwatch.listTagsForResource({
      ResourceARN: updated.dashboardArn,
    });
    expect(
      (tags.Tags ?? []).some(
        (tag) => tag.Key === "updated" && tag.Value === "true",
      ),
    ).toBe(true);

    yield* destroy();
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "create, update, delete metric and composite alarms",
  { timeout: 180_000 },
  Effect.gen(function* () {
    yield* destroy();

    const deployed = yield* test.deploy(
      Effect.gen(function* () {
        const alarm = yield* AWS.CloudWatch.Alarm("ManagedAlarm", {
          MetricName: "Errors",
          Namespace: "AWS/Lambda",
          Statistic: "Sum",
          Period: 60,
          EvaluationPeriods: 1,
          Threshold: 1,
          ComparisonOperator: "GreaterThanOrEqualToThreshold",
          TreatMissingData: "notBreaching",
          tags: {
            fixture: "cloudwatch-resource-test",
          },
        });

        const compositeAlarm = yield* AWS.CloudWatch.CompositeAlarm(
          "ManagedCompositeAlarm",
          {
            AlarmRule: alarm.alarmName.pipe(
              Output.map((alarmName) => `ALARM("${alarmName}")`),
            ),
            tags: {
              fixture: "cloudwatch-resource-test",
            },
          },
        );

        return {
          alarm,
          compositeAlarm,
        };
      }),
    );

    const described = yield* cloudwatch.describeAlarms({
      AlarmNames: [deployed.alarm.alarmName, deployed.compositeAlarm.alarmName],
    });
    expect((described.MetricAlarms ?? []).length).toBeGreaterThan(0);
    expect((described.CompositeAlarms ?? []).length).toBeGreaterThan(0);

    yield* test.deploy(
      Effect.gen(function* () {
        return yield* AWS.CloudWatch.Alarm("ManagedAlarm", {
          MetricName: "Errors",
          Namespace: "AWS/Lambda",
          Statistic: "Sum",
          Period: 60,
          EvaluationPeriods: 2,
          Threshold: 2,
          ComparisonOperator: "GreaterThanOrEqualToThreshold",
          TreatMissingData: "notBreaching",
          tags: {
            fixture: "cloudwatch-resource-test",
            updated: "true",
          },
        });
      }),
    );

    const updated = yield* cloudwatch.describeAlarms({
      AlarmNames: [deployed.alarm.alarmName],
    });
    expect(updated.MetricAlarms?.[0]?.EvaluationPeriods).toBe(2);

    yield* destroy();
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "create and delete anomaly detector",
  { timeout: 180_000 },
  Effect.gen(function* () {
    yield* destroy();

    yield* test.deploy(
      Effect.gen(function* () {
        return yield* AWS.CloudWatch.AnomalyDetector("ManagedDetector", {
          Namespace: "AWS/Lambda",
          MetricName: "Errors",
          Stat: "Sum",
        });
      }),
    );

    const described = yield* cloudwatch.describeAnomalyDetectors({
      Namespace: "AWS/Lambda",
      MetricName: "Errors",
    });
    expect((described.AnomalyDetectors ?? []).length).toBeGreaterThan(0);

    yield* destroy();
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "create and delete insight rule and alarm mute rule",
  { timeout: 180_000 },
  Effect.gen(function* () {
    yield* destroy();

    const deployed = yield* test.deploy(
      Effect.gen(function* () {
        const logGroup = yield* AWS.Logs.LogGroup("ManagedInsightLogs", {
          retentionInDays: 7,
        });

        const alarm = yield* AWS.CloudWatch.Alarm("ManagedMuteTargetAlarm", {
          MetricName: "Errors",
          Namespace: "AWS/Lambda",
          Statistic: "Sum",
          Period: 60,
          EvaluationPeriods: 1,
          Threshold: 1,
          ComparisonOperator: "GreaterThanOrEqualToThreshold",
          TreatMissingData: "notBreaching",
        });

        const insightRule = yield* AWS.CloudWatch.InsightRule(
          "ManagedInsightRule",
          {
            RuleState: "ENABLED",
            RuleDefinition: logGroup.logGroupName.pipe(
              Output.map((logGroupName) => ({
                Schema: {
                  Name: "CloudWatchLogRule",
                  Version: 1,
                },
                LogGroupNames: [logGroupName],
                LogFormat: "JSON",
                Contribution: {
                  Keys: ["$.fixture"],
                  Filters: [],
                },
                AggregateOn: "Count",
              })),
            ),
          },
        );

        const alarmMuteRule = yield* AWS.CloudWatch.AlarmMuteRule(
          "ManagedMuteRule",
          {
            Rule: {
              Schedule: {
                Expression: "cron(0 0 1 1 ? 2099)",
                Duration: "PT1H",
              },
            },
            MuteTargets: {
              AlarmNames: [alarm.alarmName],
            },
          },
        );

        return {
          insightRule,
          alarmMuteRule,
        };
      }),
    );

    const rules = yield* cloudwatch.describeInsightRules({});
    expect(
      (rules.InsightRules ?? []).some(
        (rule) => rule.Name === deployed.insightRule.ruleName,
      ),
    ).toBe(true);

    const muteRule = yield* cloudwatch.getAlarmMuteRule({
      AlarmMuteRuleName: deployed.alarmMuteRule.alarmMuteRuleName,
    });
    expect(muteRule.Name).toBe(deployed.alarmMuteRule.alarmMuteRuleName);

    yield* destroy();
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "create and delete metric stream when fixture ARNs are configured",
  { timeout: 180_000 },
  Effect.gen(function* () {
    if (!firehoseArn || !metricStreamRoleArn) {
      return;
    }

    yield* destroy();

    const stream = yield* test.deploy(
      Effect.gen(function* () {
        return yield* AWS.CloudWatch.MetricStream("ManagedMetricStream", {
          FirehoseArn: firehoseArn,
          RoleArn: metricStreamRoleArn,
          OutputFormat: "json",
        });
      }),
    );

    const described = yield* cloudwatch.getMetricStream({
      Name: stream.metricStreamName,
    });
    expect(described.Name).toBe(stream.metricStreamName);

    yield* destroy();
  }).pipe(Effect.provide(AWS.providers())),
);
