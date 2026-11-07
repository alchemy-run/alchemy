<!-- Docs for the generated AWS.CostExplorer bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## GetAnomalies

Runtime binding for `ce:GetAnomalies`.

Retrieve the cost anomalies a monitor detected during a date
interval (available for up to 90 days). Provide the implementation with
`Effect.provide(AWS.CostExplorer.GetAnomaliesHttp)`.
### Anomaly Detection at Runtime
**Example:** List a Monitor's Anomalies
```typescript
// init — bind the operation to the monitor
const getAnomalies = yield* AWS.CostExplorer.GetAnomalies(monitor);

// runtime
const result = yield* getAnomalies({
  DateInterval: { StartDate: "2026-06-01" },
});
const anomalies = result.Anomalies;
```

@binding

## GetAnomalies.Request

Request for {@link GetAnomalies} — the bound monitor's ARN is
injected automatically.

## GetApproximateUsageRecords

Runtime binding for `ce:GetApproximateUsageRecords`.

Retrieve estimated counts of hourly (or daily resource-level)
usage records per service — useful for sizing Data Exports and CUR
deliveries before enabling them. Provide the implementation with
`Effect.provide(AWS.CostExplorer.GetApproximateUsageRecordsHttp)`.
### Querying Cost and Usage
**Example:** Estimate Usage Record Volume
```typescript
// init — account-level binding takes no resource
const getApproximateUsageRecords = yield* AWS.CostExplorer.GetApproximateUsageRecords();

// runtime
const result = yield* getApproximateUsageRecords({
  Granularity: "HOURLY",
  ApproximationDimension: "SERVICE",
});
const total = result.TotalRecords;
```

@binding

## GetApproximateUsageRecords.Request

Request for {@link GetApproximateUsageRecords}.

## GetCommitmentPurchaseAnalysis

Runtime binding for `ce:GetCommitmentPurchaseAnalysis`.

Retrieve a commitment purchase analysis result by its
`AnalysisId`. Provide the implementation with
`Effect.provide(AWS.CostExplorer.GetCommitmentPurchaseAnalysisHttp)`.
### Commitment Purchase Analysis
**Example:** Read an Analysis Result
```typescript
// init — account-level binding takes no resource
const getCommitmentPurchaseAnalysis = yield* AWS.CostExplorer.GetCommitmentPurchaseAnalysis();

// runtime
const result = yield* getCommitmentPurchaseAnalysis({
  AnalysisId: analysisId,
});
const status = result.AnalysisStatus;
```

@binding

## GetCommitmentPurchaseAnalysis.Request

Request for {@link GetCommitmentPurchaseAnalysis}.

## GetCostAndUsage

Runtime binding for `ce:GetCostAndUsage`.

Query cost and usage metrics (`UnblendedCost`, `UsageQuantity`, …)
filtered and grouped by dimension over a time range — the core Cost
Explorer query. Provide the implementation with
`Effect.provide(AWS.CostExplorer.GetCostAndUsageHttp)`.
### Querying Cost and Usage
**Example:** Query Last Month's Unblended Cost
```typescript
// init — account-level binding takes no resource
const getCostAndUsage = yield* AWS.CostExplorer.GetCostAndUsage();

// runtime
const result = yield* getCostAndUsage({
  TimePeriod: { Start: "2026-06-01", End: "2026-07-01" },
  Granularity: "MONTHLY",
  Metrics: ["UnblendedCost"],
});
const total = result.ResultsByTime?.[0]?.Total?.UnblendedCost?.Amount;
```

@binding

## GetCostAndUsage.Request

Request for {@link GetCostAndUsage}.

## GetCostAndUsageComparisons

Runtime binding for `ce:GetCostAndUsageComparisons`.

Compare cost and usage between two periods within the last 13
months (up to 38 months with multi-year data enabled). Provide the implementation with
`Effect.provide(AWS.CostExplorer.GetCostAndUsageComparisonsHttp)`.
### Querying Cost and Usage
**Example:** Compare Two Billing Periods
```typescript
// init — account-level binding takes no resource
const getCostAndUsageComparisons = yield* AWS.CostExplorer.GetCostAndUsageComparisons();

// runtime
const result = yield* getCostAndUsageComparisons({
  BaselineTimePeriod: { Start: "2026-05-01", End: "2026-06-01" },
  ComparisonTimePeriod: { Start: "2026-06-01", End: "2026-07-01" },
  MetricForComparison: "UnblendedCost",
});
```

@binding

## GetCostAndUsageComparisons.Request

Request for {@link GetCostAndUsageComparisons}.

## GetCostAndUsageWithResources

Runtime binding for `ce:GetCostAndUsageWithResources`.

Query cost and usage at individual-resource granularity (EC2
instance ids etc.). Requires resource-level data to be enabled in Cost
Explorer settings and only covers the trailing 14 days. Provide the implementation with
`Effect.provide(AWS.CostExplorer.GetCostAndUsageWithResourcesHttp)`.
### Querying Cost and Usage
**Example:** Query Resource-Level Cost
```typescript
// init — account-level binding takes no resource
const getCostAndUsageWithResources = yield* AWS.CostExplorer.GetCostAndUsageWithResources();

// runtime
const result = yield* getCostAndUsageWithResources({
  TimePeriod: { Start: "2026-07-01", End: "2026-07-14" },
  Granularity: "DAILY",
  Filter: { Dimensions: { Key: "SERVICE", Values: ["Amazon Elastic Compute Cloud - Compute"] } },
  Metrics: ["UnblendedCost"],
});
```

@binding

## GetCostAndUsageWithResources.Request

Request for {@link GetCostAndUsageWithResources}.

## GetCostCategories

Runtime binding for `ce:GetCostCategories`.

Retrieve the cost category names (or the values of one category)
present in your cost data — usable in query filter expressions. Provide the implementation with
`Effect.provide(AWS.CostExplorer.GetCostCategoriesHttp)`.
### Exploring Dimensions and Tags
**Example:** List Cost Category Names and Values
```typescript
// init — account-level binding takes no resource
const getCostCategories = yield* AWS.CostExplorer.GetCostCategories();

// runtime
const result = yield* getCostCategories({
  TimePeriod: { Start: "2026-06-01", End: "2026-07-01" },
});
const names = result.CostCategoryNames;
```

@binding

## GetCostCategories.Request

Request for {@link GetCostCategories}.

## GetCostComparisonDrivers

Runtime binding for `ce:GetCostComparisonDrivers`.

Retrieve the top cost drivers explaining the change between two
billing periods — which services, accounts, or usage types moved the
bill. Provide the implementation with
`Effect.provide(AWS.CostExplorer.GetCostComparisonDriversHttp)`.
### Querying Cost and Usage
**Example:** Find What Drove a Cost Change
```typescript
// init — account-level binding takes no resource
const getCostComparisonDrivers = yield* AWS.CostExplorer.GetCostComparisonDrivers();

// runtime
const result = yield* getCostComparisonDrivers({
  BaselineTimePeriod: { Start: "2026-05-01", End: "2026-06-01" },
  ComparisonTimePeriod: { Start: "2026-06-01", End: "2026-07-01" },
  MetricForComparison: "UnblendedCost",
});
```

@binding

## GetCostComparisonDrivers.Request

Request for {@link GetCostComparisonDrivers}.

## GetCostForecast

Runtime binding for `ce:GetCostForecast`.

Forecast how much AWS predicts you will spend over a future time
period, with an optional prediction interval. Provide the implementation with
`Effect.provide(AWS.CostExplorer.GetCostForecastHttp)`.
### Forecasting
**Example:** Forecast Next Month's Spend
```typescript
// init — account-level binding takes no resource
const getCostForecast = yield* AWS.CostExplorer.GetCostForecast();

// runtime
const result = yield* getCostForecast({
  TimePeriod: { Start: "2026-08-01", End: "2026-09-01" },
  Metric: "UNBLENDED_COST",
  Granularity: "MONTHLY",
});
const forecast = result.Total?.Amount;
```

@binding

## GetCostForecast.Request

Request for {@link GetCostForecast}.

## GetDimensionValues

Runtime binding for `ce:GetDimensionValues`.

Retrieve the available values for a Cost Explorer dimension
(services, linked accounts, regions, usage types, …) — the building
blocks of query filter expressions. Provide the implementation with
`Effect.provide(AWS.CostExplorer.GetDimensionValuesHttp)`.
### Exploring Dimensions and Tags
**Example:** List Available Services
```typescript
// init — account-level binding takes no resource
const getDimensionValues = yield* AWS.CostExplorer.GetDimensionValues();

// runtime
const result = yield* getDimensionValues({
  TimePeriod: { Start: "2026-06-01", End: "2026-07-01" },
  Dimension: "SERVICE",
});
const services = (result.DimensionValues ?? []).map((v) => v.Value);
```

@binding

## GetDimensionValues.Request

Request for {@link GetDimensionValues}.

## GetReservationCoverage

Runtime binding for `ce:GetReservationCoverage`.

Retrieve how much of your eligible usage (EC2, RDS, ElastiCache,
Redshift, OpenSearch, …) was covered by reservations over a time
period. Provide the implementation with
`Effect.provide(AWS.CostExplorer.GetReservationCoverageHttp)`.
### Reservations
**Example:** Check Reservation Coverage
```typescript
// init — account-level binding takes no resource
const getReservationCoverage = yield* AWS.CostExplorer.GetReservationCoverage();

// runtime
const result = yield* getReservationCoverage({
  TimePeriod: { Start: "2026-06-01", End: "2026-07-01" },
});
const coverage = result.Total?.CoverageHours?.CoverageHoursPercentage;
```

@binding

## GetReservationCoverage.Request

Request for {@link GetReservationCoverage}.

## GetReservationUtilization

Runtime binding for `ce:GetReservationUtilization`.

Retrieve how fully your reservations were utilized over a time
range, optionally grouped by subscription. Provide the implementation with
`Effect.provide(AWS.CostExplorer.GetReservationUtilizationHttp)`.
### Reservations
**Example:** Check Reservation Utilization
```typescript
// init — account-level binding takes no resource
const getReservationUtilization = yield* AWS.CostExplorer.GetReservationUtilization();

// runtime
const result = yield* getReservationUtilization({
  TimePeriod: { Start: "2026-06-01", End: "2026-07-01" },
});
const utilization = result.Total?.UtilizationPercentage;
```

@binding

## GetReservationUtilization.Request

Request for {@link GetReservationUtilization}.

## GetRightsizingRecommendation

Runtime binding for `ce:GetRightsizingRecommendation`.

Get recommendations for idle and underutilized EC2 instances —
terminate or downsize suggestions with estimated savings. Provide the implementation with
`Effect.provide(AWS.CostExplorer.GetRightsizingRecommendationHttp)`.
### Rightsizing
**Example:** Get EC2 Rightsizing Recommendations
```typescript
// init — account-level binding takes no resource
const getRightsizingRecommendation = yield* AWS.CostExplorer.GetRightsizingRecommendation();

// runtime
const result = yield* getRightsizingRecommendation({
  Service: "AmazonEC2",
});
const recommendations = result.RightsizingRecommendations;
```

@binding

## GetRightsizingRecommendation.Request

Request for {@link GetRightsizingRecommendation}.

## GetSavingsPlansCoverage

Runtime binding for `ce:GetSavingsPlansCoverage`.

Retrieve how much of your eligible spend was covered by Savings
Plans over a time period. Provide the implementation with
`Effect.provide(AWS.CostExplorer.GetSavingsPlansCoverageHttp)`.
### Savings Plans
**Example:** Check Savings Plans Coverage
```typescript
// init — account-level binding takes no resource
const getSavingsPlansCoverage = yield* AWS.CostExplorer.GetSavingsPlansCoverage();

// runtime
const result = yield* getSavingsPlansCoverage({
  TimePeriod: { Start: "2026-06-01", End: "2026-07-01" },
});
```

@binding

## GetSavingsPlansCoverage.Request

Request for {@link GetSavingsPlansCoverage}.

## GetSavingsPlansUtilization

Runtime binding for `ce:GetSavingsPlansUtilization`.

Retrieve aggregate Savings Plans utilization across a date range
with daily or monthly granularity. Provide the implementation with
`Effect.provide(AWS.CostExplorer.GetSavingsPlansUtilizationHttp)`.
### Savings Plans
**Example:** Check Savings Plans Utilization
```typescript
// init — account-level binding takes no resource
const getSavingsPlansUtilization = yield* AWS.CostExplorer.GetSavingsPlansUtilization();

// runtime
const result = yield* getSavingsPlansUtilization({
  TimePeriod: { Start: "2026-06-01", End: "2026-07-01" },
});
```

@binding

## GetSavingsPlansUtilization.Request

Request for {@link GetSavingsPlansUtilization}.

## GetSavingsPlansUtilizationDetails

Runtime binding for `ce:GetSavingsPlansUtilizationDetails`.

Retrieve per-Savings-Plan attribute, utilization, and savings
detail for a time period. Provide the implementation with
`Effect.provide(AWS.CostExplorer.GetSavingsPlansUtilizationDetailsHttp)`.
### Savings Plans
**Example:** Per-Plan Utilization Details
```typescript
// init — account-level binding takes no resource
const getSavingsPlansUtilizationDetails = yield* AWS.CostExplorer.GetSavingsPlansUtilizationDetails();

// runtime
const result = yield* getSavingsPlansUtilizationDetails({
  TimePeriod: { Start: "2026-06-01", End: "2026-07-01" },
});
```

@binding

## GetSavingsPlansUtilizationDetails.Request

Request for {@link GetSavingsPlansUtilizationDetails}.

## GetTags

Runtime binding for `ce:GetTags`.

Retrieve the cost allocation tag keys (or the values of one key)
present in your cost data over a time period. Provide the implementation with
`Effect.provide(AWS.CostExplorer.GetTagsHttp)`.
### Exploring Dimensions and Tags
**Example:** List Cost Allocation Tag Values
```typescript
// init — account-level binding takes no resource
const getTags = yield* AWS.CostExplorer.GetTags();

// runtime
const result = yield* getTags({
  TimePeriod: { Start: "2026-06-01", End: "2026-07-01" },
});
const keys = result.Tags;
```

@binding

## GetTags.Request

Request for {@link GetTags}.

## GetUsageForecast

Runtime binding for `ce:GetUsageForecast`.

Forecast usage quantity (e.g. hours, requests) over a future time
period for a filtered slice of your usage. Provide the implementation with
`Effect.provide(AWS.CostExplorer.GetUsageForecastHttp)`.
### Forecasting
**Example:** Forecast Usage Quantity
```typescript
// init — account-level binding takes no resource
const getUsageForecast = yield* AWS.CostExplorer.GetUsageForecast();

// runtime
const result = yield* getUsageForecast({
  TimePeriod: { Start: "2026-08-01", End: "2026-09-01" },
  Metric: "USAGE_QUANTITY",
  Granularity: "MONTHLY",
  Filter: { Dimensions: { Key: "USAGE_TYPE_GROUP", Values: ["EC2: Running Hours"] } },
});
```

@binding

## GetUsageForecast.Request

Request for {@link GetUsageForecast}.

## ListCommitmentPurchaseAnalyses

Runtime binding for `ce:ListCommitmentPurchaseAnalyses`.

List the commitment purchase analyses run in your account. Provide the implementation with
`Effect.provide(AWS.CostExplorer.ListCommitmentPurchaseAnalysesHttp)`.
### Commitment Purchase Analysis
**Example:** List Analyses
```typescript
// init — account-level binding takes no resource
const listCommitmentPurchaseAnalyses = yield* AWS.CostExplorer.ListCommitmentPurchaseAnalyses();

// runtime
const result = yield* listCommitmentPurchaseAnalyses();
const analyses = result.AnalysisSummaryList;
```

@binding

## ListCommitmentPurchaseAnalyses.Request

Request for {@link ListCommitmentPurchaseAnalyses}.

## ListCostAllocationTags

Runtime binding for `ce:ListCostAllocationTags`.

List your cost allocation tags with their activation status —
user-defined and AWS-generated. Provide the implementation with
`Effect.provide(AWS.CostExplorer.ListCostAllocationTagsHttp)`.
### Cost Allocation Tags
**Example:** List Cost Allocation Tags
```typescript
// init — account-level binding takes no resource
const listCostAllocationTags = yield* AWS.CostExplorer.ListCostAllocationTags();

// runtime
const result = yield* listCostAllocationTags();
const tags = result.CostAllocationTags;
```

@binding

## ListCostAllocationTags.Request

Request for {@link ListCostAllocationTags}.

## ProvideAnomalyFeedback

Runtime binding for `ce:ProvideAnomalyFeedback`.

Record feedback on a detected anomaly (`YES` / `NO` /
`PLANNED_ACTIVITY`), improving future detection. Anomalies are
addressed by id; per the `ce` service authorization reference the action
supports no resource types, so this is an account-level binding. Provide the implementation with
`Effect.provide(AWS.CostExplorer.ProvideAnomalyFeedbackHttp)`.
### Anomaly Detection at Runtime
**Example:** Mark an Anomaly as Expected
```typescript
// init — account-level binding takes no resource
const provideAnomalyFeedback = yield* AWS.CostExplorer.ProvideAnomalyFeedback();

// runtime
yield* provideAnomalyFeedback({
  AnomalyId: anomalyId,
  Feedback: "PLANNED_ACTIVITY",
});
```

@binding

## ProvideAnomalyFeedback.Request

Request for {@link ProvideAnomalyFeedback}.

## StartCommitmentPurchaseAnalysis

Runtime binding for `ce:StartCommitmentPurchaseAnalysis`.

Start an analysis of a planned Savings Plans commitment purchase —
projects the cost impact before you buy. Provide the implementation with
`Effect.provide(AWS.CostExplorer.StartCommitmentPurchaseAnalysisHttp)`.
### Commitment Purchase Analysis
**Example:** Analyze a Planned Commitment
```typescript
// init — account-level binding takes no resource
const startCommitmentPurchaseAnalysis = yield* AWS.CostExplorer.StartCommitmentPurchaseAnalysis();

// runtime
const result = yield* startCommitmentPurchaseAnalysis({
  CommitmentPurchaseAnalysisConfiguration: configuration,
});
const analysisId = result.AnalysisId;
```

@binding

## StartCommitmentPurchaseAnalysis.Request

Request for {@link StartCommitmentPurchaseAnalysis}.

## StartCostAllocationTagBackfill

Runtime binding for `ce:StartCostAllocationTagBackfill`.

Backfill cost allocation tag activation status to past billing
periods (allowed once every 24 hours). Provide the implementation with
`Effect.provide(AWS.CostExplorer.StartCostAllocationTagBackfillHttp)`.
### Cost Allocation Tags
**Example:** Backfill Tag Activation
```typescript
// init — account-level binding takes no resource
const startCostAllocationTagBackfill = yield* AWS.CostExplorer.StartCostAllocationTagBackfill();

// runtime
const result = yield* startCostAllocationTagBackfill({
  BackfillFrom: "2026-01-01T00:00:00Z",
});
```

@binding

## StartCostAllocationTagBackfill.Request

Request for {@link StartCostAllocationTagBackfill}.

## UpdateCostAllocationTagsStatus

Runtime binding for `ce:UpdateCostAllocationTagsStatus`.

Activate or deactivate cost allocation tag keys in bulk (max 20
per call). Activation makes the tag usable in cost queries, categories,
and CUR reports. Provide the implementation with
`Effect.provide(AWS.CostExplorer.UpdateCostAllocationTagsStatusHttp)`.
### Cost Allocation Tags
**Example:** Activate a Tag Key
```typescript
// init — account-level binding takes no resource
const updateCostAllocationTagsStatus = yield* AWS.CostExplorer.UpdateCostAllocationTagsStatus();

// runtime
yield* updateCostAllocationTagsStatus({
  CostAllocationTagsStatus: [{ TagKey: "team", Status: "Active" }],
});
```

@binding

## UpdateCostAllocationTagsStatus.Request

Request for {@link UpdateCostAllocationTagsStatus}.
