<!-- Docs for the generated AWS.DevOpsGuru bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DeleteInsight

Runtime binding for `devops-guru:DeleteInsight`.

Deletes a closed insight — housekeeping automation for insights that have been triaged and resolved. Only closed insights can be deleted.
Provide the implementation with
`Effect.provide(AWS.DevOpsGuru.DeleteInsightHttp)`.
### Inspecting Insights
**Example:** Delete a Closed Insight
```typescript
// init — account-level binding, no resource argument
const deleteInsight = yield* AWS.DevOpsGuru.DeleteInsight();

// runtime
yield* deleteInsight({ Id: insightId });
```

@binding

## DescribeAccountHealth

Runtime binding for `devops-guru:DescribeAccountHealth`.

Returns the number of open reactive and proactive insights, analyzed metrics, and resource hours for the account — the top line of an operations dashboard.
Provide the implementation with
`Effect.provide(AWS.DevOpsGuru.DescribeAccountHealthHttp)`.
### Account Health
**Example:** Read Open Insight Counts
```typescript
// init — account-level binding, no resource argument
const describeAccountHealth = yield* AWS.DevOpsGuru.DescribeAccountHealth();

// runtime
const health = yield* describeAccountHealth();
yield* Effect.log(`open reactive insights: ${health.OpenReactiveInsights}`);
```

@binding

## DescribeAccountOverview

Runtime binding for `devops-guru:DescribeAccountOverview`.

Summarizes the insights created and the mean time to recover over a time range — the account's operational scorecard for a reporting window.
Provide the implementation with
`Effect.provide(AWS.DevOpsGuru.DescribeAccountOverviewHttp)`.
### Account Health
**Example:** Summarize a Time Range
```typescript
// init — account-level binding, no resource argument
const describeAccountOverview = yield* AWS.DevOpsGuru.DescribeAccountOverview();

// runtime
const overview = yield* describeAccountOverview({
  FromTime: new Date(Date.now() - 7 * 24 * 3600_000),
});
yield* Effect.log(`MTTR: ${overview.MeanTimeToRecoverInMilliseconds}ms`);
```

@binding

## DescribeAnomaly

Runtime binding for `devops-guru:DescribeAnomaly`.

Returns the details of a single anomaly — severity, status, time ranges, and the CloudWatch/Performance Insights metrics that triggered it.
Provide the implementation with
`Effect.provide(AWS.DevOpsGuru.DescribeAnomalyHttp)`.
### Inspecting Anomalies
**Example:** Read an Anomaly's Detail
```typescript
// init — account-level binding, no resource argument
const describeAnomaly = yield* AWS.DevOpsGuru.DescribeAnomaly();

// runtime
const { ReactiveAnomaly } = yield* describeAnomaly({ Id: anomalyId });
yield* Effect.log(`severity: ${ReactiveAnomaly?.Severity}`);
```

@binding

## DescribeFeedback

Runtime binding for `devops-guru:DescribeFeedback`.

Returns the most recently recorded feedback (e.g. `VALID` / `NOT_VALID`) for an insight.
Provide the implementation with
`Effect.provide(AWS.DevOpsGuru.DescribeFeedbackHttp)`.
### Feedback
**Example:** Read Recorded Feedback
```typescript
// init — account-level binding, no resource argument
const describeFeedback = yield* AWS.DevOpsGuru.DescribeFeedback();

// runtime
const { InsightFeedback } = yield* describeFeedback({ InsightId: insightId });
yield* Effect.log(`feedback: ${InsightFeedback?.Feedback}`);
```

@binding

## DescribeInsight

Runtime binding for `devops-guru:DescribeInsight`.

Returns the details of a single insight — severity, status, time ranges, and the SSM OpsItem id when OpsCenter integration is enabled. The building block of an incident-response Function reacting to DevOps Guru notifications.
Provide the implementation with
`Effect.provide(AWS.DevOpsGuru.DescribeInsightHttp)`.
### Inspecting Insights
**Example:** Read an Insight's Detail
```typescript
// init — account-level binding, no resource argument
const describeInsight = yield* AWS.DevOpsGuru.DescribeInsight();

// runtime
const { ReactiveInsight } = yield* describeInsight({ Id: insightId });
yield* Effect.log(`${ReactiveInsight?.Severity}: ${ReactiveInsight?.Name}`);
```

@binding

## DescribeOrganizationHealth

Runtime binding for `devops-guru:DescribeOrganizationHealth`.

Returns the number of open insights and analyzed resources across the organization (management or delegated-administrator account).
Provide the implementation with
`Effect.provide(AWS.DevOpsGuru.DescribeOrganizationHealthHttp)`.
### Organization Visibility
**Example:** Read Organization-Wide Insight Counts
```typescript
// init — account-level binding, no resource argument
const describeOrganizationHealth = yield* AWS.DevOpsGuru.DescribeOrganizationHealth();

// runtime
const health = yield* describeOrganizationHealth();
yield* Effect.log(`org open reactive: ${health.OpenReactiveInsights}`);
```

@binding

## DescribeOrganizationOverview

Runtime binding for `devops-guru:DescribeOrganizationOverview`.

Summarizes the insights created across the organization during a time range (management or delegated-administrator account).
Provide the implementation with
`Effect.provide(AWS.DevOpsGuru.DescribeOrganizationOverviewHttp)`.
### Organization Visibility
**Example:** Summarize the Organization over a Time Range
```typescript
// init — account-level binding, no resource argument
const describeOrganizationOverview = yield* AWS.DevOpsGuru.DescribeOrganizationOverview();

// runtime
const overview = yield* describeOrganizationOverview({
  FromTime: new Date(Date.now() - 7 * 24 * 3600_000),
});
yield* Effect.log(`reactive insights: ${overview.ReactiveInsights}`);
```

@binding

## DescribeOrganizationResourceCollectionHealth

Runtime binding for `devops-guru:DescribeOrganizationResourceCollectionHealth`.

Returns per-CloudFormation-stack (or per-tag/per-service) insight counts across the organization's accounts.
Provide the implementation with
`Effect.provide(AWS.DevOpsGuru.DescribeOrganizationResourceCollectionHealthHttp)`.
### Organization Visibility
**Example:** Read Per-Stack Health Across Accounts
```typescript
// init — account-level binding, no resource argument
const describeOrganizationResourceCollectionHealth = yield* AWS.DevOpsGuru.DescribeOrganizationResourceCollectionHealth();

// runtime
const page = yield* describeOrganizationResourceCollectionHealth({
  OrganizationResourceCollectionType: "AWS_CLOUD_FORMATION",
});
yield* Effect.log(`stacks analyzed: ${page.CloudFormation?.length}`);
```

@binding

## DescribeResourceCollectionHealth

Runtime binding for `devops-guru:DescribeResourceCollectionHealth`.

Returns the number of open insights per analyzed CloudFormation stack or app-boundary tag — where the operational pain is concentrated.
Provide the implementation with
`Effect.provide(AWS.DevOpsGuru.DescribeResourceCollectionHealthHttp)`.
### Coverage Health
**Example:** Read Per-Stack Health
```typescript
// init — account-level binding, no resource argument
const describeResourceCollectionHealth = yield* AWS.DevOpsGuru.DescribeResourceCollectionHealth();

// runtime
const page = yield* describeResourceCollectionHealth({
  ResourceCollectionType: "AWS_CLOUD_FORMATION",
});
for (const stack of page.CloudFormation ?? []) {
  yield* Effect.log(`${stack.StackName}: ${stack.Insight?.OpenReactiveInsights}`);
}
```

@binding

## GetCostEstimation

Runtime binding for `devops-guru:GetCostEstimation`.

Returns the result of the most recent cost estimation started with `StartCostEstimation` — the estimated monthly cost of DevOps Guru analyzing the candidate resource collection.
Provide the implementation with
`Effect.provide(AWS.DevOpsGuru.GetCostEstimationHttp)`.
### Cost Estimation
**Example:** Read the Latest Estimate
```typescript
// init — account-level binding, no resource argument
const getCostEstimation = yield* AWS.DevOpsGuru.GetCostEstimation();

// runtime
const estimate = yield* getCostEstimation();
yield* Effect.log(`estimated: ${estimate.TotalCost} (${estimate.Status})`);
```

@binding

## ListAnomaliesForInsight

Runtime binding for `devops-guru:ListAnomaliesForInsight`.

Lists the anomalies that belong to an insight — the individual metric deviations DevOps Guru correlated into the incident.
Provide the implementation with
`Effect.provide(AWS.DevOpsGuru.ListAnomaliesForInsightHttp)`.
### Inspecting Anomalies
**Example:** List an Insight's Anomalies
```typescript
// init — account-level binding, no resource argument
const listAnomaliesForInsight = yield* AWS.DevOpsGuru.ListAnomaliesForInsight();

// runtime
const { ReactiveAnomalies } = yield* listAnomaliesForInsight({
  InsightId: insightId,
});
yield* Effect.log(`anomalies: ${ReactiveAnomalies?.length}`);
```

@binding

## ListAnomalousLogGroups

Runtime binding for `devops-guru:ListAnomalousLogGroups`.

Lists the CloudWatch log groups that contain log anomalies for an insight (requires the service integration's log anomaly detection).
Provide the implementation with
`Effect.provide(AWS.DevOpsGuru.ListAnomalousLogGroupsHttp)`.
### Inspecting Anomalies
**Example:** List an Insight's Anomalous Log Groups
```typescript
// init — account-level binding, no resource argument
const listAnomalousLogGroups = yield* AWS.DevOpsGuru.ListAnomalousLogGroups();

// runtime
const { AnomalousLogGroups } = yield* listAnomalousLogGroups({
  InsightId: insightId,
});
for (const group of AnomalousLogGroups ?? []) {
  yield* Effect.log(`${group.LogGroupName}: ${group.NumberOfLogLinesScanned} lines`);
}
```

@binding

## ListEvents

Runtime binding for `devops-guru:ListEvents`.

Lists the infrastructure and deployment events (CloudTrail changes, deployments, schema changes) DevOps Guru evaluated around an insight — the "what changed?" of an incident.
Provide the implementation with
`Effect.provide(AWS.DevOpsGuru.ListEventsHttp)`.
### Events and Recommendations
**Example:** List Deployment Events Around an Insight
```typescript
// init — account-level binding, no resource argument
const listEvents = yield* AWS.DevOpsGuru.ListEvents();

// runtime
const { Events } = yield* listEvents({
  Filters: { InsightId: insightId, DataSource: "AWS_CLOUD_TRAIL" },
});
yield* Effect.log(`events: ${Events?.length}`);
```

@binding

## ListInsights

Runtime binding for `devops-guru:ListInsights`.

Lists the account's insights filtered by status (ongoing, closed, or any within a time range) and type (reactive/proactive).
Provide the implementation with
`Effect.provide(AWS.DevOpsGuru.ListInsightsHttp)`.
### Inspecting Insights
**Example:** List Ongoing Insights
```typescript
// init — account-level binding, no resource argument
const listInsights = yield* AWS.DevOpsGuru.ListInsights();

// runtime
const { ReactiveInsights } = yield* listInsights({
  StatusFilter: { Ongoing: { Type: "REACTIVE" } },
});
yield* Effect.log(`ongoing: ${ReactiveInsights?.length}`);
```

@binding

## ListMonitoredResources

Runtime binding for `devops-guru:ListMonitoredResources`.

Lists the resources DevOps Guru is analyzing (or supports analyzing) — an audit of what the resource collection actually covers.
Provide the implementation with
`Effect.provide(AWS.DevOpsGuru.ListMonitoredResourcesHttp)`.
### Coverage Health
**Example:** List Analyzed Resources
```typescript
// init — account-level binding, no resource argument
const listMonitoredResources = yield* AWS.DevOpsGuru.ListMonitoredResources();

// runtime
const { MonitoredResourceIdentifiers } = yield* listMonitoredResources();
yield* Effect.log(`monitored: ${MonitoredResourceIdentifiers?.length}`);
```

@binding

## ListOrganizationInsights

Runtime binding for `devops-guru:ListOrganizationInsights`.

Lists insights across the organization's accounts filtered by status and type (management or delegated-administrator account).
Provide the implementation with
`Effect.provide(AWS.DevOpsGuru.ListOrganizationInsightsHttp)`.
### Organization Visibility
**Example:** List Insights Across Accounts
```typescript
// init — account-level binding, no resource argument
const listOrganizationInsights = yield* AWS.DevOpsGuru.ListOrganizationInsights();

// runtime
const { ReactiveInsights } = yield* listOrganizationInsights({
  StatusFilter: { Ongoing: { Type: "REACTIVE" } },
});
yield* Effect.log(`org ongoing: ${ReactiveInsights?.length}`);
```

@binding

## ListRecommendations

Runtime binding for `devops-guru:ListRecommendations`.

Lists DevOps Guru's remediation recommendations for an insight — the ready-made content of an incident notification or runbook comment.
Provide the implementation with
`Effect.provide(AWS.DevOpsGuru.ListRecommendationsHttp)`.
### Events and Recommendations
**Example:** List an Insight's Recommendations
```typescript
// init — account-level binding, no resource argument
const listRecommendations = yield* AWS.DevOpsGuru.ListRecommendations();

// runtime
const { Recommendations } = yield* listRecommendations({
  InsightId: insightId,
});
for (const rec of Recommendations ?? []) {
  yield* Effect.log(`${rec.Name}: ${rec.Description}`);
}
```

@binding

## PutFeedback

Runtime binding for `devops-guru:PutFeedback`.

Records feedback on an insight's usefulness (`VALID` / `NOT_VALID` and variants) — feeding triage decisions back into DevOps Guru.
Provide the implementation with
`Effect.provide(AWS.DevOpsGuru.PutFeedbackHttp)`.
### Feedback
**Example:** Rate an Insight
```typescript
// init — account-level binding, no resource argument
const putFeedback = yield* AWS.DevOpsGuru.PutFeedback();

// runtime
yield* putFeedback({
  InsightFeedback: { Id: insightId, Feedback: "VALID_COLLECTION" },
});
```

@binding

## SearchInsights

Runtime binding for `devops-guru:SearchInsights`.

Searches the account's insights within a start-time range, filtered by severity, status, service, or resource collection. The service
requires both `FromTime` and `ToTime` on the range.
Provide the implementation with
`Effect.provide(AWS.DevOpsGuru.SearchInsightsHttp)`.
### Inspecting Insights
**Example:** Search Insights by Severity
```typescript
// init — account-level binding, no resource argument
const searchInsights = yield* AWS.DevOpsGuru.SearchInsights();

// runtime
const { ReactiveInsights } = yield* searchInsights({
  Type: "REACTIVE",
  StartTimeRange: {
    FromTime: new Date(Date.now() - 24 * 3600_000),
    ToTime: new Date(),
  },
  Filters: { Severities: ["HIGH"] },
});
yield* Effect.log(`high severity: ${ReactiveInsights?.length}`);
```

@binding

## SearchOrganizationInsights

Runtime binding for `devops-guru:SearchOrganizationInsights`.

Searches insights across specific organization accounts within a start-time range (management or delegated-administrator account). The
service requires both `FromTime` and `ToTime` on the range.
Provide the implementation with
`Effect.provide(AWS.DevOpsGuru.SearchOrganizationInsightsHttp)`.
### Organization Visibility
**Example:** Search Insights Across Accounts
```typescript
// init — account-level binding, no resource argument
const searchOrganizationInsights = yield* AWS.DevOpsGuru.SearchOrganizationInsights();

// runtime
const { ReactiveInsights } = yield* searchOrganizationInsights({
  AccountIds: ["111111111111"],
  Type: "REACTIVE",
  StartTimeRange: {
    FromTime: new Date(Date.now() - 24 * 3600_000),
    ToTime: new Date(),
  },
});
yield* Effect.log(`found: ${ReactiveInsights?.length}`);
```

@binding

## StartCostEstimation

Runtime binding for `devops-guru:StartCostEstimation`.

Starts estimating the monthly cost of DevOps Guru analyzing a candidate resource collection. Poll the result with `GetCostEstimation`.
Provide the implementation with
`Effect.provide(AWS.DevOpsGuru.StartCostEstimationHttp)`.
### Cost Estimation
**Example:** Estimate the Cost of Coverage
```typescript
// init — account-level binding, no resource argument
const startCostEstimation = yield* AWS.DevOpsGuru.StartCostEstimation();

// runtime
yield* startCostEstimation({
  ResourceCollection: { CloudFormation: { StackNames: ["my-app-prod"] } },
});
```

@binding
