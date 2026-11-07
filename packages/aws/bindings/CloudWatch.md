<!-- Docs for the generated AWS.CloudWatch bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DescribeAlarmContributors

Runtime binding for `cloudwatch:DescribeAlarmContributors` — list the
time-series contributors currently in ALARM for a contributor-enabled
metric-math alarm. Bind it to the {@link Alarm}; the alarm name is
injected automatically.

Provide `CloudWatch.DescribeAlarmContributorsHttp` on the hosting Lambda
Function to satisfy the requirement.
### Reading Alarm State
**Example:** List an Alarm's Contributors
```typescript
// init — grants cloudwatch:DescribeAlarmContributors on the alarm
const describeAlarmContributors =
  yield* AWS.CloudWatch.DescribeAlarmContributors(alarm);

// runtime — plain metric alarms have no contributor data; the typed
// errors let you treat that as an empty result
const contributors = yield* describeAlarmContributors().pipe(
  Effect.map((r) => r.AlarmContributors ?? []),
  Effect.catchTag(
    ["ResourceNotFoundException", "ValidationException"],
    () => Effect.succeed([]),
  ),
);
```

@binding

## DescribeAlarmHistory

Runtime binding for `cloudwatch:DescribeAlarmHistory` — read state
transitions and configuration changes recorded for alarms in the
account/region.

Provide `CloudWatch.DescribeAlarmHistoryHttp` on the hosting Lambda
Function to satisfy the requirement.
### Reading Alarm State
**Example:** Read an Alarm's Recent History
```typescript
// init — grants cloudwatch:DescribeAlarmHistory
const describeAlarmHistory = yield* AWS.CloudWatch.DescribeAlarmHistory();

// runtime
const result = yield* describeAlarmHistory({
  AlarmName: yield* alarm.alarmName,
  MaxRecords: 10,
});
const items = result.AlarmHistoryItems ?? [];
```

@binding

## DescribeAlarmsForMetric

Runtime binding for `cloudwatch:DescribeAlarmsForMetric` — find the
alarms watching a specific metric.

Provide `CloudWatch.DescribeAlarmsForMetricHttp` on the hosting Lambda
Function to satisfy the requirement.
### Reading Alarm State
**Example:** Find Alarms Watching a Metric
```typescript
// init — grants cloudwatch:DescribeAlarmsForMetric
const describeAlarmsForMetric = yield* AWS.CloudWatch.DescribeAlarmsForMetric();

// runtime
const result = yield* describeAlarmsForMetric({
  Namespace: "MyApp/Payments",
  MetricName: "PaymentProcessed",
  Statistic: "Sum",
  Period: 60,
});
const alarmNames = (result.MetricAlarms ?? []).map((a) => a.AlarmName);
```

@binding

## DescribeAnomalyDetectors

Runtime binding for `cloudwatch:DescribeAnomalyDetectors` — list the
anomaly detection models in the account/region, optionally filtered by
namespace, metric name, or dimensions.

Provide `CloudWatch.DescribeAnomalyDetectorsHttp` on the hosting Lambda
Function to satisfy the requirement.
### Reading Anomaly Detectors
**Example:** List Detectors in a Namespace
```typescript
// init — grants cloudwatch:DescribeAnomalyDetectors
const describeAnomalyDetectors = yield* AWS.CloudWatch.DescribeAnomalyDetectors();

// runtime
const result = yield* describeAnomalyDetectors({
  Namespace: "MyApp/Payments",
});
const detectors = result.AnomalyDetectors ?? [];
```

@binding

## DescribeInsightRules

Runtime binding for `cloudwatch:DescribeInsightRules` — list the
Contributor Insights rules in the account/region.

Provide `CloudWatch.DescribeInsightRulesHttp` on the hosting Lambda
Function to satisfy the requirement.
### Reading Insight Rules
**Example:** List Contributor Insights Rules
```typescript
// init — grants cloudwatch:DescribeInsightRules
const describeInsightRules = yield* AWS.CloudWatch.DescribeInsightRules();

// runtime
const result = yield* describeInsightRules();
const names = (result.InsightRules ?? []).map((rule) => rule.Name);
```

@binding

## GetAlarmMuteRule

Runtime binding for `cloudwatch:GetAlarmMuteRule` — read the
configuration of the bound {@link AlarmMuteRule}; the rule name is
injected automatically.

Provide `CloudWatch.GetAlarmMuteRuleHttp` on the hosting Lambda Function
to satisfy the requirement.
### Reading Mute Rules
**Example:** Read a Bound Mute Rule
```typescript
// init — grants cloudwatch:GetAlarmMuteRule on the rule
const getAlarmMuteRule = yield* AWS.CloudWatch.GetAlarmMuteRule(muteRule);

// runtime
const result = yield* getAlarmMuteRule();
const schedule = result.Rule?.Schedule;
```

@binding

## GetDashboard

Runtime binding for `cloudwatch:GetDashboard` — read the body and
metadata of the bound {@link Dashboard}; the dashboard name is injected
automatically.

Provide `CloudWatch.GetDashboardHttp` on the hosting Lambda Function to
satisfy the requirement.
### Reading Dashboards
**Example:** Read a Bound Dashboard
```typescript
// init — grants cloudwatch:GetDashboard on the dashboard
const getDashboard = yield* AWS.CloudWatch.GetDashboard(dashboard);

// runtime
const result = yield* getDashboard();
const widgets = JSON.parse(result.DashboardBody ?? "{}").widgets;
```

@binding

## GetInsightRuleReport

Runtime binding for `cloudwatch:GetInsightRuleReport` — fetch the
top-contributor report for the bound {@link InsightRule}; the rule name
is injected automatically.

Provide `CloudWatch.GetInsightRuleReportHttp` on the hosting Lambda
Function to satisfy the requirement.
### Reading Insight Rules
**Example:** Fetch the Top Contributors for a Rule
```typescript
// init — grants cloudwatch:GetInsightRuleReport on the rule
const getInsightRuleReport = yield* AWS.CloudWatch.GetInsightRuleReport(rule);

// runtime
const now = yield* Effect.sync(() => Date.now());
const result = yield* getInsightRuleReport({
  StartTime: new Date(now - 3_600_000),
  EndTime: new Date(now),
  Period: 300,
});
const contributors = result.Contributors ?? [];
```

@binding

## GetMetricData

Runtime binding for `cloudwatch:GetMetricData` — run metric-math queries
over one or more metrics in a single call.

Provide `CloudWatch.GetMetricDataHttp` on the hosting Lambda Function to
satisfy the requirement.
### Querying Metrics
**Example:** Query the Last Hour of a Custom Metric
```typescript
// init — grants cloudwatch:GetMetricData
const getMetricData = yield* AWS.CloudWatch.GetMetricData();

// runtime
const now = yield* Effect.sync(() => Date.now());
const result = yield* getMetricData({
  StartTime: new Date(now - 3_600_000),
  EndTime: new Date(now),
  MetricDataQueries: [
    {
      Id: "m1",
      MetricStat: {
        Metric: { Namespace: "MyApp/Payments", MetricName: "PaymentProcessed" },
        Period: 60,
        Stat: "Sum",
      },
    },
  ],
});
const series = result.MetricDataResults ?? [];
```

@binding

## GetMetricStatistics

Runtime binding for `cloudwatch:GetMetricStatistics` — fetch aggregated
datapoints for a single metric (the older single-metric query API;
prefer {@link GetMetricData} for metric math or multi-metric queries).

Provide `CloudWatch.GetMetricStatisticsHttp` on the hosting Lambda
Function to satisfy the requirement.
### Querying Metrics
**Example:** Fetch Hourly Sums for a Metric
```typescript
// init — grants cloudwatch:GetMetricStatistics
const getMetricStatistics = yield* AWS.CloudWatch.GetMetricStatistics();

// runtime
const now = yield* Effect.sync(() => Date.now());
const result = yield* getMetricStatistics({
  Namespace: "MyApp/Payments",
  MetricName: "PaymentProcessed",
  StartTime: new Date(now - 3_600_000),
  EndTime: new Date(now),
  Period: 60,
  Statistics: ["Sum"],
});
const datapoints = result.Datapoints ?? [];
```

@binding

## GetMetricStream

Runtime binding for `cloudwatch:GetMetricStream` — read the
configuration and state of the bound {@link MetricStream}; the stream
name is injected automatically.

Provide `CloudWatch.GetMetricStreamHttp` on the hosting Lambda Function
to satisfy the requirement.
### Reading Metric Streams
**Example:** Read a Bound Metric Stream
```typescript
// init — grants cloudwatch:GetMetricStream on the stream
const getMetricStream = yield* AWS.CloudWatch.GetMetricStream(metricStream);

// runtime
const result = yield* getMetricStream();
const state = result.State; // "running" | "stopped"
```

@binding

## GetMetricWidgetImage

Runtime binding for `cloudwatch:GetMetricWidgetImage` — render a metric
graph as a PNG (useful for embedding charts in alerts or reports).

Provide `CloudWatch.GetMetricWidgetImageHttp` on the hosting Lambda
Function to satisfy the requirement.
### Rendering Metric Graphs
**Example:** Render a Metric Graph as PNG
```typescript
// init — grants cloudwatch:GetMetricWidgetImage
const getMetricWidgetImage = yield* AWS.CloudWatch.GetMetricWidgetImage();

// runtime
const result = yield* getMetricWidgetImage({
  MetricWidget: JSON.stringify({
    metrics: [["MyApp/Payments", "PaymentProcessed"]],
    width: 600,
    height: 400,
    start: "-PT3H",
  }),
});
const png = result.MetricWidgetImage; // image bytes
```

@binding

## ListAlarmMuteRules

Runtime binding for `cloudwatch:ListAlarmMuteRules` — list the alarm
mute rules in the account/region.

Provide `CloudWatch.ListAlarmMuteRulesHttp` on the hosting Lambda
Function to satisfy the requirement.
### Reading Mute Rules
**Example:** List Alarm Mute Rules
```typescript
// init — grants cloudwatch:ListAlarmMuteRules
const listAlarmMuteRules = yield* AWS.CloudWatch.ListAlarmMuteRules();

// runtime
const result = yield* listAlarmMuteRules();
const summaries = result.AlarmMuteRuleSummaries ?? [];
```

@binding

## ListDashboards

Runtime binding for `cloudwatch:ListDashboards` — list the dashboards in
the account, optionally filtered by name prefix.

Provide `CloudWatch.ListDashboardsHttp` on the hosting Lambda Function
to satisfy the requirement.
### Reading Dashboards
**Example:** List Dashboards
```typescript
// init — grants cloudwatch:ListDashboards
const listDashboards = yield* AWS.CloudWatch.ListDashboards();

// runtime
const result = yield* listDashboards();
const names = (result.DashboardEntries ?? []).map((e) => e.DashboardName);
```

@binding

## ListManagedInsightRules

Runtime binding for `cloudwatch:ListManagedInsightRules` — list the
managed Contributor Insights rules available for a given AWS resource
ARN.

Provide `CloudWatch.ListManagedInsightRulesHttp` on the hosting Lambda
Function to satisfy the requirement.
### Reading Insight Rules
**Example:** List Managed Rules for a Resource
```typescript
// init — grants cloudwatch:ListManagedInsightRules
const listManagedInsightRules = yield* AWS.CloudWatch.ListManagedInsightRules();

// runtime — only specific AWS resource types support managed rules;
// an unsupported ARN fails with the typed InvalidParameterValueException
const result = yield* listManagedInsightRules({
  ResourceARN: yield* table.tableArn,
});
const rules = result.ManagedRules ?? [];
```

@binding

## ListMetricStreams

Runtime binding for `cloudwatch:ListMetricStreams` — list the metric
streams in the account/region.

Provide `CloudWatch.ListMetricStreamsHttp` on the hosting Lambda
Function to satisfy the requirement.
### Reading Metric Streams
**Example:** List Metric Streams
```typescript
// init — grants cloudwatch:ListMetricStreams
const listMetricStreams = yield* AWS.CloudWatch.ListMetricStreams();

// runtime
const result = yield* listMetricStreams();
const entries = result.Entries ?? [];
```

@binding

## ListMetrics

Runtime binding for `cloudwatch:ListMetrics` — enumerate the metrics
visible in the account/region, optionally filtered by namespace, metric
name, or dimensions.

Provide `CloudWatch.ListMetricsHttp` on the hosting Lambda Function to
satisfy the requirement.
### Listing Metrics
**Example:** List Metrics in a Namespace
```typescript
// init — grants cloudwatch:ListMetrics
const listMetrics = yield* AWS.CloudWatch.ListMetrics();

// runtime
const result = yield* listMetrics({ Namespace: "MyApp/Payments" });
const names = (result.Metrics ?? []).map((metric) => metric.MetricName);
```

@binding

## ListTagsForResource

Runtime binding for `cloudwatch:ListTagsForResource` — read the tags on
a bound CloudWatch resource (alarm, dashboard, metric stream, insight
rule, or mute rule); the resource ARN is injected automatically.

Provide `CloudWatch.ListTagsForResourceHttp` on the hosting Lambda
Function to satisfy the requirement.
### Reading Tags
**Example:** Read the Tags on an Alarm
```typescript
// init — grants cloudwatch:ListTagsForResource on the alarm's ARN
const listTagsForResource = yield* AWS.CloudWatch.ListTagsForResource(alarm);

// runtime
const result = yield* listTagsForResource();
const tags = result.Tags ?? [];
```

@binding

## PutMetricData

Runtime binding for `cloudwatch:PutMetricData` — publish custom metric
datums from inside a function runtime.

Provide `CloudWatch.PutMetricDataHttp` on the hosting Lambda Function to
satisfy the requirement. For high-volume publishing prefer the batching
{@link MetricSink}, which packs datums into 1000-datum `PutMetricData`
calls.
### Publishing Metrics
**Example:** Publish a Custom Metric from a Lambda Function
```typescript
export default MyFunction.make(
  { main: import.meta.url, functionUrl: true },
  Effect.gen(function* () {
    // init — grants cloudwatch:PutMetricData to the function
    const putMetricData = yield* AWS.CloudWatch.PutMetricData();

    return {
      fetch: Effect.gen(function* () {
        // runtime — publish a datum on every request
        yield* putMetricData({
          Namespace: "MyApp/Payments",
          MetricData: [
            { MetricName: "PaymentProcessed", Value: 1, Unit: "Count" },
          ],
        });
        return HttpServerResponse.text("ok");
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(AWS.CloudWatch.PutMetricDataHttp)),
);
```

@binding

## SetAlarmState

Runtime binding for `cloudwatch:SetAlarmState` — force the bound alarm
into a specific state (useful for testing alarm actions or resetting a
stuck alarm). Bind it to an {@link Alarm} / {@link CompositeAlarm}; the
alarm name is injected automatically.

Provide `CloudWatch.SetAlarmStateHttp` on the hosting Lambda Function to
satisfy the requirement.
### Managing Alarm Actions
**Example:** Force an Alarm into ALARM to Test Its Actions
```typescript
// init — grants cloudwatch:SetAlarmState on the alarm
const setAlarmState = yield* AWS.CloudWatch.SetAlarmState(alarm);

// runtime
yield* setAlarmState({
  StateValue: "ALARM",
  StateReason: "fire-drill: verifying the on-call page",
});
```

@binding
