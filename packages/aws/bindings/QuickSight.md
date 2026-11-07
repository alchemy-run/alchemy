<!-- Docs for the generated AWS.QuickSight bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CancelIngestion

Runtime binding for `quicksight:CancelIngestion`.

Cancels an in-flight SPICE ingestion on the bound {@link DataSet}.
`AwsAccountId` and `DataSetId` are injected from the binding. Provide the
implementation with `Effect.provide(AWS.QuickSight.CancelIngestionHttp)`.
### Refreshing SPICE Data
**Example:** Cancel A Running Refresh
```typescript
// init — bind the operation to the dataset
const cancelIngestion = yield* AWS.QuickSight.CancelIngestion(dataSet);

// runtime
yield* cancelIngestion({ IngestionId: ingestionId });
```

@binding

## CreateIngestion

Runtime binding for `quicksight:CreateIngestion`.

Triggers a SPICE refresh (ingestion) of the bound {@link DataSet} — e.g.
after a pipeline lands new data. `AwsAccountId` and `DataSetId` are
injected from the binding; the caller supplies a unique `IngestionId`.
Poll the refresh with
{@link DescribeIngestion | AWS.QuickSight.DescribeIngestion}. Provide the
implementation with `Effect.provide(AWS.QuickSight.CreateIngestionHttp)`.
### Refreshing SPICE Data
**Example:** Trigger A Full Refresh
```typescript
// init — bind the operation to the dataset
const createIngestion = yield* AWS.QuickSight.CreateIngestion(dataSet);

// runtime
const { IngestionId, IngestionStatus } = yield* createIngestion({
  IngestionId: crypto.randomUUID(),
  IngestionType: "FULL_REFRESH",
});
```

@binding

## DescribeDashboardSnapshotJob

Runtime binding for `quicksight:DescribeDashboardSnapshotJob`.

Reads the status (`QUEUED`, `RUNNING`, `COMPLETED`, `FAILED`) and
configuration of a snapshot job started on the bound {@link Dashboard}.
`AwsAccountId` and `DashboardId` are injected from the binding. Provide the
implementation with
`Effect.provide(AWS.QuickSight.DescribeDashboardSnapshotJobHttp)`.
### Dashboard Snapshots
**Example:** Poll A Snapshot Job Until It Completes
```typescript
// init — bind the operation to the dashboard
const describeSnapshotJob =
  yield* AWS.QuickSight.DescribeDashboardSnapshotJob(dashboard);

// runtime
const job = yield* describeSnapshotJob({ SnapshotJobId: jobId }).pipe(
  Effect.repeat({
    schedule: Schedule.spaced("5 seconds"),
    until: (j) => j.JobStatus === "COMPLETED" || j.JobStatus === "FAILED",
    times: 24,
  }),
);
```

@binding

## DescribeDashboardSnapshotJobResult

Runtime binding for `quicksight:DescribeDashboardSnapshotJobResult`.

Fetches the result of a `COMPLETED` snapshot job on the bound
{@link Dashboard} — the S3 destination or pre-signed download URLs of the
generated files, or the error details of a `FAILED` job. `AwsAccountId`
and `DashboardId` are injected from the binding. Provide the
implementation with
`Effect.provide(AWS.QuickSight.DescribeDashboardSnapshotJobResultHttp)`.
### Dashboard Snapshots
**Example:** Download A Completed Snapshot
```typescript
// init — bind the operation to the dashboard
const describeSnapshotJobResult =
  yield* AWS.QuickSight.DescribeDashboardSnapshotJobResult(dashboard);

// runtime
const { Result } = yield* describeSnapshotJobResult({
  SnapshotJobId: jobId,
});
const url = Result?.AnonymousUsers?.[0]?.FileGroups?.[0]?.Files?.[0];
```

@binding

## DescribeIngestion

Runtime binding for `quicksight:DescribeIngestion`.

Reads the status, row counts, and error info of a SPICE ingestion on the
bound {@link DataSet}. `AwsAccountId` and `DataSetId` are injected from
the binding. Provide the implementation with
`Effect.provide(AWS.QuickSight.DescribeIngestionHttp)`.
### Refreshing SPICE Data
**Example:** Poll An Ingestion Until It Settles
```typescript
// init — bind the operation to the dataset
const describeIngestion = yield* AWS.QuickSight.DescribeIngestion(dataSet);

// runtime
const { Ingestion } = yield* describeIngestion({
  IngestionId: ingestionId,
}).pipe(
  Effect.repeat({
    schedule: Schedule.spaced("5 seconds"),
    until: (r) =>
      r.Ingestion?.IngestionStatus === "COMPLETED" ||
      r.Ingestion?.IngestionStatus === "FAILED",
    times: 24,
  }),
);
```

@binding

## ListIngestions

Runtime binding for `quicksight:ListIngestions`.

Lists the SPICE ingestion history of the bound {@link DataSet} (most
recent first) — useful for skipping a refresh that is already running or
for surfacing the last refresh outcome. `AwsAccountId` and `DataSetId`
are injected from the binding. Provide the implementation with
`Effect.provide(AWS.QuickSight.ListIngestionsHttp)`.
### Refreshing SPICE Data
**Example:** Read The Latest Refresh Outcome
```typescript
// init — bind the operation to the dataset
const listIngestions = yield* AWS.QuickSight.ListIngestions(dataSet);

// runtime
const { Ingestions } = yield* listIngestions({ MaxResults: 1 });
const latest = Ingestions?.[0];
```

@binding

## StartDashboardSnapshotJob

Runtime binding for `quicksight:StartDashboardSnapshotJob`.

Starts an asynchronous snapshot job that exports the bound
{@link Dashboard} as a PDF, CSV, or Excel file delivered to S3 or returned
as a download URL. `AwsAccountId` and `DashboardId` are injected from the
binding; poll the job with
{@link DescribeDashboardSnapshotJob | AWS.QuickSight.DescribeDashboardSnapshotJob}.
Provide the implementation with
`Effect.provide(AWS.QuickSight.StartDashboardSnapshotJobHttp)`.
### Dashboard Snapshots
**Example:** Start A PDF Snapshot
```typescript
// init — bind the operation to the dashboard
const startSnapshotJob =
  yield* AWS.QuickSight.StartDashboardSnapshotJob(dashboard);

// runtime
const { SnapshotJobId } = yield* startSnapshotJob({
  SnapshotJobId: crypto.randomUUID(),
  UserConfiguration: { AnonymousUsers: [] },
  SnapshotConfiguration: {
    FileGroups: [{ Files: [{ FormatType: "PDF" }] }],
  },
});
```

@binding
