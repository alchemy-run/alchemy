<!-- Docs for the generated AWS.Forecast bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CreateAutoPredictor

Runtime binding for `forecast:CreateAutoPredictor` — kick off (re)training
of an AutoPredictor from a dataset group, the scheduled-retraining step of
a grandfathered Forecast deployment. Also grants `iam:PassRole`
(conditioned to `forecast.amazonaws.com`) for the KMS-encryption role an
`EncryptionConfig` passes to the service.

Predictor ARNs are created at runtime, so the binding takes no arguments
and grants `forecast:CreateAutoPredictor` on `*`. Provide the
implementation with `Effect.provide(AWS.Forecast.CreateAutoPredictorHttp)`.

### Training Predictors
**Example:** Retrain a Predictor
```typescript
// init
const createAutoPredictor = yield* AWS.Forecast.CreateAutoPredictor();

// runtime
const predictor = yield* createAutoPredictor({
  PredictorName: "demand_2026_07",
  ForecastHorizon: 14,
  ForecastFrequency: "D",
  DataConfig: { DatasetGroupArn: group.datasetGroupArn },
});
```

@binding

## CreateDatasetImportJob

Runtime binding for `forecast:CreateDatasetImportJob` — start an
asynchronous import of training data from S3 into a Forecast dataset, the
standard scheduled-ingest step of a grandfathered Forecast deployment.
Also grants `iam:PassRole` (conditioned to `forecast.amazonaws.com`) for
the S3 data-access role the import assumes.

The import job's ARN is created at runtime, so the binding takes no
arguments and grants `forecast:CreateDatasetImportJob` on `*`. Provide the
implementation with `Effect.provide(AWS.Forecast.CreateDatasetImportJobHttp)`.

### Importing Data
**Example:** Start a Scheduled Import
```typescript
// init
const createDatasetImportJob = yield* AWS.Forecast.CreateDatasetImportJob();

// runtime
const job = yield* createDatasetImportJob({
  DatasetImportJobName: "daily_2026_07_14",
  DatasetArn: dataset.datasetArn,
  DataSource: {
    S3Config: {
      Path: "s3://my-bucket/demand.csv",
      RoleArn: dataAccessRole.roleArn,
    },
  },
  TimestampFormat: "yyyy-MM-dd",
});
```

@binding

## CreateForecast

Runtime binding for `forecast:CreateForecast` — generate a fresh forecast
from a trained predictor, the scheduled step that keeps the queryable
forecast current after each retraining or data import.

Forecast ARNs are created at runtime, so the binding takes no arguments
and grants `forecast:CreateForecast` on `*`. Provide the implementation
with `Effect.provide(AWS.Forecast.CreateForecastHttp)`.

### Generating Forecasts
**Example:** Regenerate the Forecast
```typescript
// init
const createForecast = yield* AWS.Forecast.CreateForecast();

// runtime
const generated = yield* createForecast({
  ForecastName: "demand_2026_07_14",
  PredictorArn: predictorArn,
});
```

@binding

## CreateForecastExportJob

Runtime binding for `forecast:CreateForecastExportJob` — export a complete
forecast to S3 as CSV/Parquet, the bulk-consumption path that complements
per-item lookups via {@link QueryForecast}.

Export job ARNs are created at runtime, so the binding takes no arguments
and grants `forecast:CreateForecastExportJob` on `*`, plus `iam:PassRole`
(conditioned to `forecast.amazonaws.com`) for the export destination role.
Provide the implementation with
`Effect.provide(AWS.Forecast.CreateForecastExportJobHttp)`.

### Exporting Forecasts
**Example:** Export the Forecast to S3
```typescript
// init
const createForecastExportJob = yield* AWS.Forecast.CreateForecastExportJob();

// runtime
const job = yield* createForecastExportJob({
  ForecastExportJobName: "demand_2026_07_14_export",
  ForecastArn: forecastArn,
  Destination: {
    S3Config: { Path: "s3://my-bucket/forecasts/", RoleArn: exportRoleArn },
  },
});
```

@binding

## CreateWhatIfAnalysis

Runtime binding for `forecast:CreateWhatIfAnalysis` — start a what-if
analysis on a baseline forecast, the container under which scenario
forecasts (price changes, promotions) are created and later compared via
{@link QueryWhatIfForecast}.

What-if analysis ARNs are created at runtime, so the binding takes no
arguments and grants `forecast:CreateWhatIfAnalysis` on `*`. Provide the
implementation with `Effect.provide(AWS.Forecast.CreateWhatIfAnalysisHttp)`.

### What-If Scenarios
**Example:** Start a What-If Analysis
```typescript
// init
const createWhatIfAnalysis = yield* AWS.Forecast.CreateWhatIfAnalysis();

// runtime
const analysis = yield* createWhatIfAnalysis({
  WhatIfAnalysisName: "promo_scenarios",
  ForecastArn: forecastArn,
});
```

@binding

## CreateWhatIfForecast

Runtime binding for `forecast:CreateWhatIfForecast` — create a scenario
forecast under a what-if analysis, transforming the baseline time series
(or replacing it from S3) so the outcome can be compared with
{@link QueryWhatIfForecast}.

What-if forecast ARNs are created at runtime, so the binding takes no
arguments and grants `forecast:CreateWhatIfForecast` on `*`, plus
`iam:PassRole` (conditioned to `forecast.amazonaws.com`) for the
replacement-data-source role. Provide the implementation with
`Effect.provide(AWS.Forecast.CreateWhatIfForecastHttp)`.

### What-If Scenarios
**Example:** Create a Price-Drop Scenario
```typescript
// init
const createWhatIfForecast = yield* AWS.Forecast.CreateWhatIfForecast();

// runtime
const scenario = yield* createWhatIfForecast({
  WhatIfForecastName: "price_drop_10pct",
  WhatIfAnalysisArn: analysisArn,
  TimeSeriesTransformations: [
    {
      Action: {
        AttributeName: "price",
        Operation: "MULTIPLY",
        Value: 0.9,
      },
    },
  ],
});
```

@binding

## CreateWhatIfForecastExport

Runtime binding for `forecast:CreateWhatIfForecastExport` — export one or
more scenario forecasts to S3 as CSV/Parquet so they can be compared
offline or fed into downstream analytics.

What-if forecast export ARNs are created at runtime, so the binding takes
no arguments and grants `forecast:CreateWhatIfForecastExport` on `*`, plus
`iam:PassRole` (conditioned to `forecast.amazonaws.com`) for the export
destination role. Provide the implementation with
`Effect.provide(AWS.Forecast.CreateWhatIfForecastExportHttp)`.

### Exporting Forecasts
**Example:** Export Scenario Forecasts
```typescript
// init
const createWhatIfForecastExport =
  yield* AWS.Forecast.CreateWhatIfForecastExport();

// runtime
const job = yield* createWhatIfForecastExport({
  WhatIfForecastExportName: "promo_scenarios_export",
  WhatIfForecastArns: [scenarioArn],
  Destination: {
    S3Config: { Path: "s3://my-bucket/whatif/", RoleArn: exportRoleArn },
  },
});
```

@binding

## DeleteResourceTree

Runtime binding for `forecast:DeleteResourceTree` — delete an entire tree
of runtime-created Forecast resources (a predictor and its forecasts and
exports, or a dataset's import jobs) in a single call, the cost-hygiene
counterpart to the `Create*` bindings.

The target ARNs are created at runtime, so the binding takes no arguments
and grants `forecast:DeleteResourceTree` on `*`. Provide the implementation
with `Effect.provide(AWS.Forecast.DeleteResourceTreeHttp)`.

### Cleaning Up
**Example:** Delete a Predictor's Artifact Tree
```typescript
// init
const deleteResourceTree = yield* AWS.Forecast.DeleteResourceTree();

// runtime
yield* deleteResourceTree({ ResourceArn: predictorArn });
```

@binding

## DescribeAutoPredictor

Runtime binding for `forecast:DescribeAutoPredictor` — poll a training run
started by {@link CreateAutoPredictor} until its `Status` reaches `ACTIVE`
(or `CREATE_FAILED`) and read its estimated time remaining.

Predictor ARNs are created at runtime, so the binding takes no arguments
and grants `forecast:DescribeAutoPredictor` on `*`. Provide the
implementation with `Effect.provide(AWS.Forecast.DescribeAutoPredictorHttp)`.

### Training Predictors
**Example:** Poll a Training Run
```typescript
// init
const describeAutoPredictor = yield* AWS.Forecast.DescribeAutoPredictor();

// runtime
const detail = yield* describeAutoPredictor({
  PredictorArn: predictor.PredictorArn!,
});
yield* Effect.log(`training ${detail.Status}`);
```

@binding

## DescribeDatasetImportJob

Runtime binding for `forecast:DescribeDatasetImportJob` — poll an import
job started by {@link CreateDatasetImportJob} until its `Status` reaches
`ACTIVE` (or `CREATE_FAILED`), and read its field statistics.

Import-job ARNs are created at runtime, so the binding takes no arguments
and grants `forecast:DescribeDatasetImportJob` on `*`. Provide the
implementation with
`Effect.provide(AWS.Forecast.DescribeDatasetImportJobHttp)`.

### Importing Data
**Example:** Poll an Import Job
```typescript
// init
const describeDatasetImportJob = yield* AWS.Forecast.DescribeDatasetImportJob();

// runtime
const detail = yield* describeDatasetImportJob({
  DatasetImportJobArn: job.DatasetImportJobArn!,
});
if (detail.Status === "CREATE_FAILED") {
  yield* Effect.logError(`import failed: ${detail.Message}`);
}
```

@binding

## DescribeForecast

Runtime binding for `forecast:DescribeForecast` — poll a forecast
generation started by {@link CreateForecast} until its `Status` reaches
`ACTIVE` and it becomes queryable.

Forecast ARNs are created at runtime, so the binding takes no arguments
and grants `forecast:DescribeForecast` on `*`. Provide the implementation
with `Effect.provide(AWS.Forecast.DescribeForecastHttp)`.

### Generating Forecasts
**Example:** Wait for a Forecast to Become Queryable
```typescript
// init
const describeForecast = yield* AWS.Forecast.DescribeForecast();

// runtime
const detail = yield* describeForecast({
  ForecastArn: generated.ForecastArn!,
});
yield* Effect.log(`forecast ${detail.Status}`);
```

@binding

## DescribeForecastExportJob

Runtime binding for `forecast:DescribeForecastExportJob` — poll the status
of a forecast export started with {@link CreateForecastExportJob} until
the files land in S3.

Export job ARNs are created at runtime, so the binding takes no arguments
and grants `forecast:DescribeForecastExportJob` on `*`. Provide the
implementation with
`Effect.provide(AWS.Forecast.DescribeForecastExportJobHttp)`.

### Exporting Forecasts
**Example:** Poll an Export Job
```typescript
// init
const describeForecastExportJob =
  yield* AWS.Forecast.DescribeForecastExportJob();

// runtime
const { Status } = yield* describeForecastExportJob({
  ForecastExportJobArn: exportJobArn,
});
```

@binding

## DescribeWhatIfAnalysis

Runtime binding for `forecast:DescribeWhatIfAnalysis` — poll the status of
a what-if analysis created with {@link CreateWhatIfAnalysis} until it is
`ACTIVE` and scenario forecasts can be created under it.

What-if analysis ARNs are created at runtime, so the binding takes no
arguments and grants `forecast:DescribeWhatIfAnalysis` on `*`. Provide the
implementation with
`Effect.provide(AWS.Forecast.DescribeWhatIfAnalysisHttp)`.

### What-If Scenarios
**Example:** Poll a What-If Analysis
```typescript
// init
const describeWhatIfAnalysis = yield* AWS.Forecast.DescribeWhatIfAnalysis();

// runtime
const { Status } = yield* describeWhatIfAnalysis({
  WhatIfAnalysisArn: analysisArn,
});
```

@binding

## DescribeWhatIfForecast

Runtime binding for `forecast:DescribeWhatIfForecast` — poll the status of
a scenario forecast created with {@link CreateWhatIfForecast} until it is
`ACTIVE` and queryable via {@link QueryWhatIfForecast}.

What-if forecast ARNs are created at runtime, so the binding takes no
arguments and grants `forecast:DescribeWhatIfForecast` on `*`. Provide the
implementation with
`Effect.provide(AWS.Forecast.DescribeWhatIfForecastHttp)`.

### What-If Scenarios
**Example:** Poll a Scenario Forecast
```typescript
// init
const describeWhatIfForecast = yield* AWS.Forecast.DescribeWhatIfForecast();

// runtime
const { Status } = yield* describeWhatIfForecast({
  WhatIfForecastArn: scenarioArn,
});
```

@binding

## DescribeWhatIfForecastExport

Runtime binding for `forecast:DescribeWhatIfForecastExport` — poll the
status of a scenario-forecast export started with
{@link CreateWhatIfForecastExport} until the files land in S3.

Export ARNs are created at runtime, so the binding takes no arguments and
grants `forecast:DescribeWhatIfForecastExport` on `*`. Provide the
implementation with
`Effect.provide(AWS.Forecast.DescribeWhatIfForecastExportHttp)`.

### Exporting Forecasts
**Example:** Poll a Scenario Export
```typescript
// init
const describeWhatIfForecastExport =
  yield* AWS.Forecast.DescribeWhatIfForecastExport();

// runtime
const { Status } = yield* describeWhatIfForecastExport({
  WhatIfForecastExportArn: exportArn,
});
```

@binding

## GetAccuracyMetrics

Runtime binding for `forecast:GetAccuracyMetrics` — read a trained
(legacy) predictor's backtest accuracy metrics (wQL, RMSE, MAPE, WAPE) so
an ops function can gate promotion of a retrained model on its accuracy.

Predictor ARNs are created at runtime, so the binding takes no arguments
and grants `forecast:GetAccuracyMetrics` on `*`. Provide the
implementation with `Effect.provide(AWS.Forecast.GetAccuracyMetricsHttp)`.

### Training Predictors
**Example:** Gate on Accuracy
```typescript
// init
const getAccuracyMetrics = yield* AWS.Forecast.GetAccuracyMetrics();

// runtime
const metrics = yield* getAccuracyMetrics({
  PredictorArn: predictorArn,
});
```

@binding

## QueryForecast

Runtime binding for `forecast:QueryForecast` — the Forecast Query data
plane. Retrieves the predicted time series for a single item from a
generated forecast, the call an API or personalization function makes to
serve predictions.

Forecast ARNs are created at runtime, so the binding takes no arguments
and grants `forecast:QueryForecast` on `*`. Provide the implementation
with `Effect.provide(AWS.Forecast.QueryForecastHttp)`.

### Querying Forecasts
**Example:** Serve a Prediction
```typescript
// init
const queryForecast = yield* AWS.Forecast.QueryForecast();

// runtime
const { Forecast } = yield* queryForecast({
  ForecastArn: forecastArn,
  Filters: { item_id: "sku_1234" },
});
const p50 = Forecast?.Predictions?.p50 ?? [];
```

@binding

## QueryWhatIfForecast

Runtime binding for `forecast:QueryWhatIfForecast` — retrieve the
predicted time series for a single item from a what-if forecast, so an
application can compare a scenario (price change, promotion) against the
baseline served by {@link QueryForecast}.

What-if forecast ARNs are created at runtime, so the binding takes no
arguments and grants `forecast:QueryWhatIfForecast` on `*`. Provide the
implementation with `Effect.provide(AWS.Forecast.QueryWhatIfForecastHttp)`.

### Querying Forecasts
**Example:** Compare a Scenario
```typescript
// init
const queryWhatIfForecast = yield* AWS.Forecast.QueryWhatIfForecast();

// runtime
const { Forecast } = yield* queryWhatIfForecast({
  WhatIfForecastArn: whatIfForecastArn,
  Filters: { item_id: "sku_1234" },
});
```

@binding

## ResumeResource

Runtime binding for `forecast:ResumeResource` — resume a stopped Forecast
monitor so it continues evaluating a deployed predictor's drift.

Monitor ARNs are created at runtime, so the binding takes no arguments and
grants `forecast:ResumeResource` on `*`. Provide the implementation with
`Effect.provide(AWS.Forecast.ResumeResourceHttp)`.

### Managing Jobs
**Example:** Resume a Stopped Monitor
```typescript
// init
const resumeResource = yield* AWS.Forecast.ResumeResource();

// runtime
yield* resumeResource({ ResourceArn: monitorArn });
```

@binding

## StopResource

Runtime binding for `forecast:StopResource` — halt an in-progress Forecast
job (dataset import, predictor training, forecast generation, or any of
their export jobs), the cost-control lever for a runaway training run. A
stopped job cannot be resumed.

Job ARNs are created at runtime, so the binding takes no arguments and
grants `forecast:StopResource` on `*`. Provide the implementation with
`Effect.provide(AWS.Forecast.StopResourceHttp)`.

### Managing Jobs
**Example:** Halt a Runaway Training Run
```typescript
// init
const stopResource = yield* AWS.Forecast.StopResource();

// runtime
yield* stopResource({ ResourceArn: predictorArn });
```

@binding
