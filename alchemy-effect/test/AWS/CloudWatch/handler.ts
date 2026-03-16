import * as AWS from "@/AWS";
import * as Http from "@/Http";
import * as Output from "@/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

const metricNamespace = "alchemy-cloudwatch-fixture";
const metricName = "FixtureMetric";
const metricDimensionName = "Fixture";
const metricDimensionValue = "CloudWatch";

const firehoseArn = process.env.TEST_CLOUDWATCH_METRIC_STREAM_FIREHOSE_ARN;
const metricStreamRoleArn = process.env.TEST_CLOUDWATCH_METRIC_STREAM_ROLE_ARN;

const serializeError = (error: unknown) => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...(typeof error === "object" && error !== null ? error : {}),
    };
  }

  if (typeof error === "object" && error !== null) {
    return error;
  }

  return { message: String(error) };
};

const result = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.logError("CloudWatch fixture route failed", serializeError(error)).pipe(
          Effect.as({
            ok: false as const,
            error:
              typeof error === "object" && error !== null && "_tag" in error
                ? (error as { _tag: string })._tag
                : `${error}`,
            details: serializeError(error),
          }),
        ),
      onSuccess: (value) =>
        Effect.succeed({
          ok: true as const,
          value,
        }),
    }),
  );

export const CloudWatchFixture = Effect.gen(function* () {
  const logGroup = yield* AWS.Logs.LogGroup("FixtureInsightLogs", {
    retentionInDays: 7,
    tags: {
      fixture: "cloudwatch-bindings",
    },
  });

  const dashboard = yield* AWS.CloudWatch.Dashboard("FixtureDashboard", {
    DashboardBody: {
      widgets: [
        {
          type: "metric",
          width: 12,
          height: 6,
          properties: {
            metrics: [
              [
                metricNamespace,
                metricName,
                metricDimensionName,
                metricDimensionValue,
              ],
            ],
            period: 60,
            stat: "Sum",
            region: process.env.AWS_REGION ?? "us-east-1",
            title: "Fixture Metric",
          },
        },
      ],
    },
    tags: {
      fixture: "cloudwatch-bindings",
    },
  });

  const alarm = yield* AWS.CloudWatch.Alarm("FixtureAlarm", {
    MetricName: metricName,
    Namespace: metricNamespace,
    Dimensions: [
      {
        Name: metricDimensionName,
        Value: metricDimensionValue,
      },
    ],
    Statistic: "Sum",
    Period: 60,
    EvaluationPeriods: 1,
    Threshold: 1,
    ComparisonOperator: "GreaterThanOrEqualToThreshold",
    TreatMissingData: "notBreaching",
    tags: {
      fixture: "cloudwatch-bindings",
    },
  });

  const compositeAlarm = yield* AWS.CloudWatch.CompositeAlarm(
    "FixtureCompositeAlarm",
    {
      AlarmRule: alarm.alarmName.pipe(
        Output.map((alarmName) => `ALARM("${alarmName}")`),
      ),
      tags: {
        fixture: "cloudwatch-bindings",
      },
    },
  );

  const anomalyDetector = yield* AWS.CloudWatch.AnomalyDetector(
    "FixtureAnomalyDetector",
    {
      Namespace: metricNamespace,
      MetricName: metricName,
      Dimensions: [
        {
          Name: metricDimensionName,
          Value: metricDimensionValue,
        },
      ],
      Stat: "Sum",
    },
  );

  const insightRule = yield* AWS.CloudWatch.InsightRule("FixtureInsightRule", {
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
    tags: {
      fixture: "cloudwatch-bindings",
    },
  });

  const alarmMuteRule = yield* AWS.CloudWatch.AlarmMuteRule(
    "FixtureAlarmMuteRule",
    {
      Description: "Fixture mute rule",
      Rule: {
        Schedule: {
          Expression: "at(2099-01-01T00:00)",
          Duration: "PT1H",
        },
      },
      MuteTargets: {
        AlarmNames: [alarm.alarmName],
      },
      tags: {
        fixture: "cloudwatch-bindings",
      },
    },
  );

  const metricStream =
    firehoseArn && metricStreamRoleArn
      ? yield* AWS.CloudWatch.MetricStream("FixtureMetricStream", {
          FirehoseArn: firehoseArn,
          RoleArn: metricStreamRoleArn,
          OutputFormat: "json",
          IncludeFilters: [
            {
              Namespace: metricNamespace,
            },
          ],
          tags: {
            fixture: "cloudwatch-bindings",
          },
        })
      : undefined;

  const apiFunction = yield* AWS.Lambda.Function(
    "CloudWatchApiFunction",
    Effect.gen(function* () {
      const putMetricData = yield* AWS.CloudWatch.PutMetricData.bind();
      const getMetricData = yield* AWS.CloudWatch.GetMetricData.bind();
      const getMetricStatistics =
        yield* AWS.CloudWatch.GetMetricStatistics.bind();
      const getMetricWidgetImage =
        yield* AWS.CloudWatch.GetMetricWidgetImage.bind();
      const listMetrics = yield* AWS.CloudWatch.ListMetrics.bind();
      const getDashboard = yield* AWS.CloudWatch.GetDashboard.bind(dashboard);
      const listDashboards = yield* AWS.CloudWatch.ListDashboards.bind();
      const describeAlarms = yield* AWS.CloudWatch.DescribeAlarms.bind(
        alarm,
        compositeAlarm,
      );
      const describeAlarmsForMetric =
        yield* AWS.CloudWatch.DescribeAlarmsForMetric.bind();
      const describeAlarmHistory =
        yield* AWS.CloudWatch.DescribeAlarmHistory.bind();
      const describeAlarmContributors =
        yield* AWS.CloudWatch.DescribeAlarmContributors.bind(alarm);
      const enableAlarmActions =
        yield* AWS.CloudWatch.EnableAlarmActions.bind(alarm);
      const disableAlarmActions =
        yield* AWS.CloudWatch.DisableAlarmActions.bind(alarm);
      const alarmName = yield* alarm.alarmName;
      const setAlarmState = yield* AWS.CloudWatch.SetAlarmState.bind(alarm);
      const describeAnomalyDetectors =
        yield* AWS.CloudWatch.DescribeAnomalyDetectors.bind();
      const listMetricStreams = yield* AWS.CloudWatch.ListMetricStreams.bind();
      const describeInsightRules =
        yield* AWS.CloudWatch.DescribeInsightRules.bind();
      const getInsightRuleReport =
        yield* AWS.CloudWatch.GetInsightRuleReport.bind(insightRule);
      const listManagedInsightRules =
        yield* AWS.CloudWatch.ListManagedInsightRules.bind();
      const disableInsightRules =
        yield* AWS.CloudWatch.DisableInsightRules.bind(insightRule);
      const getAlarmMuteRule =
        yield* AWS.CloudWatch.GetAlarmMuteRule.bind(alarmMuteRule);
      const listAlarmMuteRules =
        yield* AWS.CloudWatch.ListAlarmMuteRules.bind();
      const listTagsForAlarm =
        yield* AWS.CloudWatch.ListTagsForResource.bind(alarm);
      const listTagsForDashboard =
        yield* AWS.CloudWatch.ListTagsForResource.bind(dashboard);
      const getMetricStream =
        metricStream &&
        (yield* AWS.CloudWatch.GetMetricStream.bind(metricStream));

      yield* Http.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest;
          const url = new URL(request.originalUrl);
          const pathname = url.pathname;

          if (request.method === "GET" && pathname === "/ready") {
            return yield* HttpServerResponse.json({ ok: true });
          }

          if (request.method === "POST" && pathname === "/metrics/put") {
            const body = (yield* request.json) as { value?: number };
            return yield* HttpServerResponse.json(
              yield* result(
                putMetricData({
                  Namespace: metricNamespace,
                  MetricData: [
                    {
                      MetricName: metricName,
                      Dimensions: [
                        {
                          Name: metricDimensionName,
                          Value: metricDimensionValue,
                        },
                      ],
                      Timestamp: new Date(),
                      Value: body.value ?? 1,
                      Unit: "Count",
                    },
                  ],
                }),
              ),
            );
          }

          if (request.method === "POST" && pathname === "/metrics/get-data") {
            const body = (yield* request.json) as {
              startTime: string;
              endTime: string;
            };
            return yield* HttpServerResponse.json(
              yield* result(
                getMetricData({
                  StartTime: new Date(body.startTime),
                  EndTime: new Date(body.endTime),
                  MetricDataQueries: [
                    {
                      Id: "fixture",
                      MetricStat: {
                        Metric: {
                          Namespace: metricNamespace,
                          MetricName: metricName,
                          Dimensions: [
                            {
                              Name: metricDimensionName,
                              Value: metricDimensionValue,
                            },
                          ],
                        },
                        Period: 60,
                        Stat: "Sum",
                      },
                    },
                  ],
                }),
              ),
            );
          }

          if (request.method === "POST" && pathname === "/metrics/get-stats") {
            const body = (yield* request.json) as {
              startTime: string;
              endTime: string;
            };
            return yield* HttpServerResponse.json(
              yield* result(
                getMetricStatistics({
                  Namespace: metricNamespace,
                  MetricName: metricName,
                  Dimensions: [
                    {
                      Name: metricDimensionName,
                      Value: metricDimensionValue,
                    },
                  ],
                  StartTime: new Date(body.startTime),
                  EndTime: new Date(body.endTime),
                  Period: 60,
                  Statistics: ["Sum"],
                }),
              ),
            );
          }

          if (request.method === "GET" && pathname === "/metrics/list") {
            return yield* HttpServerResponse.json(
              yield* result(
                listMetrics({
                  Namespace: metricNamespace,
                  MetricName: metricName,
                }),
              ),
            );
          }

          if (
            request.method === "POST" &&
            pathname === "/metrics/widget-image"
          ) {
            return yield* HttpServerResponse.json(
              yield* result(
                getMetricWidgetImage({
                  MetricWidget: JSON.stringify({
                    metrics: [
                      [
                        metricNamespace,
                        metricName,
                        metricDimensionName,
                        metricDimensionValue,
                      ],
                    ],
                    period: 60,
                    stat: "Sum",
                    region: process.env.AWS_REGION ?? "us-east-1",
                  }),
                  OutputFormat: "png",
                }),
              ),
            );
          }

          if (request.method === "GET" && pathname === "/dashboard") {
            return yield* HttpServerResponse.json(
              yield* result(getDashboard()),
            );
          }

          if (request.method === "GET" && pathname === "/dashboards") {
            return yield* HttpServerResponse.json(
              yield* result(listDashboards()),
            );
          }

          if (request.method === "GET" && pathname === "/alarms") {
            return yield* HttpServerResponse.json(
              yield* result(describeAlarms()),
            );
          }

          if (request.method === "GET" && pathname === "/alarms/for-metric") {
            return yield* HttpServerResponse.json(
              yield* result(
                describeAlarmsForMetric({
                  Namespace: metricNamespace,
                  MetricName: metricName,
                  Dimensions: [
                    {
                      Name: metricDimensionName,
                      Value: metricDimensionValue,
                    },
                  ],
                  Period: 60,
                  Statistic: "Sum",
                }),
              ),
            );
          }

          if (request.method === "GET" && pathname === "/alarms/history") {
            return yield* HttpServerResponse.json(
              yield* result(
                describeAlarmHistory({
                  AlarmName: yield* alarmName,
                }),
              ),
            );
          }

          if (request.method === "GET" && pathname === "/alarms/contributors") {
            return yield* HttpServerResponse.json(
              yield* result(describeAlarmContributors()),
            );
          }

          if (request.method === "POST" && pathname === "/alarms/set-state") {
            return yield* HttpServerResponse.json(
              yield* result(
                setAlarmState({
                  StateValue: "ALARM",
                  StateReason: "fixture test",
                }),
              ),
            );
          }

          if (
            request.method === "POST" &&
            pathname === "/alarms/disable-actions"
          ) {
            return yield* HttpServerResponse.json(
              yield* result(disableAlarmActions()),
            );
          }

          if (
            request.method === "POST" &&
            pathname === "/alarms/enable-actions"
          ) {
            return yield* HttpServerResponse.json(
              yield* result(enableAlarmActions()),
            );
          }

          if (request.method === "GET" && pathname === "/anomaly-detectors") {
            return yield* HttpServerResponse.json(
              yield* result(
                describeAnomalyDetectors({
                  Namespace: metricNamespace,
                  MetricName: metricName,
                }),
              ),
            );
          }

          if (request.method === "GET" && pathname === "/insight-rules") {
            return yield* HttpServerResponse.json(
              yield* result(describeInsightRules()),
            );
          }

          if (
            request.method === "POST" &&
            pathname === "/insight-rules/report"
          ) {
            const body = (yield* request.json) as {
              startTime: string;
              endTime: string;
            };
            return yield* HttpServerResponse.json(
              yield* result(
                getInsightRuleReport({
                  StartTime: new Date(body.startTime),
                  EndTime: new Date(body.endTime),
                  Period: 60,
                  MaxContributorCount: 5,
                }),
              ),
            );
          }

          if (
            request.method === "POST" &&
            pathname === "/insight-rules/disable"
          ) {
            return yield* HttpServerResponse.json(
              yield* result(disableInsightRules()),
            );
          }

          if (
            request.method === "GET" &&
            pathname === "/insight-rules/managed"
          ) {
            return yield* HttpServerResponse.json(
              yield* result(listManagedInsightRules()),
            );
          }

          if (request.method === "GET" && pathname === "/mute-rule") {
            return yield* HttpServerResponse.json(
              yield* result(getAlarmMuteRule()),
            );
          }

          if (request.method === "GET" && pathname === "/mute-rules") {
            return yield* HttpServerResponse.json(
              yield* result(
                listAlarmMuteRules({
                  AlarmName: yield* alarmName,
                }),
              ),
            );
          }

          if (request.method === "GET" && pathname === "/tags/alarm") {
            return yield* HttpServerResponse.json(
              yield* result(listTagsForAlarm()),
            );
          }

          if (request.method === "GET" && pathname === "/tags/dashboard") {
            return yield* HttpServerResponse.json(
              yield* result(listTagsForDashboard()),
            );
          }

          if (request.method === "GET" && pathname === "/metric-stream") {
            if (!getMetricStream) {
              return yield* HttpServerResponse.json({
                ok: true,
                skipped: true,
              });
            }

            return yield* HttpServerResponse.json(
              yield* result(getMetricStream()),
            );
          }

          if (request.method === "GET" && pathname === "/metric-streams") {
            return yield* HttpServerResponse.json(
              yield* result(listMetricStreams()),
            );
          }

          return yield* HttpServerResponse.json(
            { error: "Not found", method: request.method, pathname },
            { status: 404 },
          );
        }).pipe(Effect.orDie),
      );

      return {
        main,
        url: true,
      } as const satisfies AWS.Lambda.FunctionProps;
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          Layer.mergeAll(AWS.Lambda.HttpServer),
          Layer.mergeAll(
            AWS.CloudWatch.PutMetricDataLive,
            AWS.CloudWatch.GetMetricDataLive,
            AWS.CloudWatch.GetMetricStatisticsLive,
            AWS.CloudWatch.GetMetricWidgetImageLive,
            AWS.CloudWatch.ListMetricsLive,
            AWS.CloudWatch.GetDashboardLive,
            AWS.CloudWatch.ListDashboardsLive,
            AWS.CloudWatch.DescribeAlarmsLive,
            AWS.CloudWatch.DescribeAlarmsForMetricLive,
            AWS.CloudWatch.DescribeAlarmHistoryLive,
            AWS.CloudWatch.DescribeAlarmContributorsLive,
            AWS.CloudWatch.EnableAlarmActionsLive,
            AWS.CloudWatch.DisableAlarmActionsLive,
            AWS.CloudWatch.SetAlarmStateLive,
            AWS.CloudWatch.DescribeAnomalyDetectorsLive,
            AWS.CloudWatch.GetMetricStreamLive,
            AWS.CloudWatch.ListMetricStreamsLive,
            AWS.CloudWatch.DescribeInsightRulesLive,
            AWS.CloudWatch.GetInsightRuleReportLive,
            AWS.CloudWatch.ListManagedInsightRulesLive,
            AWS.CloudWatch.DisableInsightRulesLive,
            AWS.CloudWatch.GetAlarmMuteRuleLive,
            AWS.CloudWatch.ListAlarmMuteRulesLive,
            AWS.CloudWatch.ListTagsForResourceLive,
          ),
        ),
      ),
    ),
  );

  return {
    apiFunction,
    dashboard,
    alarm,
    compositeAlarm,
    anomalyDetector,
    insightRule,
    alarmMuteRule,
    metricStream,
    metricNamespace,
    metricName,
  };
});

export default CloudWatchFixture.pipe(
  Effect.map(({ apiFunction }) => apiFunction),
);
