<!-- Docs for the generated AWS.Glue bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## BatchCreatePartition

Runtime binding for `glue:BatchCreatePartition`.

Registers up to 100 partitions on the bound {@link Table} in one call —
the bulk variant of `CreatePartition` for backfills. Per-partition
failures come back in the response's `Errors` list. The database/table
names and catalog id are injected from the binding. Provide the
implementation with `Effect.provide(AWS.Glue.BatchCreatePartitionHttp)`.
### Managing Partitions
**Example:** Backfill Partitions
```typescript
// init
const batchCreatePartition = yield* AWS.Glue.BatchCreatePartition(table);

// runtime
const { Errors } = yield* batchCreatePartition({
  PartitionInputList: days.map((dt) => ({ Values: [dt] })),
});
```

@binding

## BatchDeletePartition

Runtime binding for `glue:BatchDeletePartition`.

Deletes up to 25 partitions of the bound {@link Table} in one call — the
bulk variant of `DeletePartition` for retention sweeps. Per-partition
failures come back in the response's `Errors` list. The database/table
names and catalog id are injected from the binding. Provide the
implementation with `Effect.provide(AWS.Glue.BatchDeletePartitionHttp)`.
### Managing Partitions
**Example:** Expire Old Partitions
```typescript
// init
const batchDeletePartition = yield* AWS.Glue.BatchDeletePartition(table);

// runtime
const { Errors } = yield* batchDeletePartition({
  PartitionsToDelete: expired.map((dt) => ({ Values: [dt] })),
});
```

@binding

## BatchGetPartition

Runtime binding for `glue:BatchGetPartition`.

Reads up to 1000 partitions of the bound {@link Table} by their partition
values in one call — the bulk variant of `GetPartition`. Values that don't
resolve come back in `UnprocessedKeys`. The database/table names and
catalog id are injected from the binding. Provide the implementation with
`Effect.provide(AWS.Glue.BatchGetPartitionHttp)`.
### Managing Partitions
**Example:** Bulk-Read Partitions
```typescript
// init
const batchGetPartition = yield* AWS.Glue.BatchGetPartition(table);

// runtime
const { Partitions } = yield* batchGetPartition({
  PartitionsToGet: [{ Values: ["2026-01-01"] }, { Values: ["2026-01-02"] }],
});
```

@binding

## BatchStopJobRun

Runtime binding for `glue:BatchStopJobRun`.

Stops one or more in-flight runs of the bound {@link Job}. Per-run
failures come back in the response's `Errors` list (the call itself
succeeds), so inspect `SuccessfulSubmissions`/`Errors` rather than the
error channel. The job name is injected from the binding. Provide the
implementation with `Effect.provide(AWS.Glue.BatchStopJobRunHttp)`.
### Running Jobs
**Example:** Stop a Run
```typescript
// init
const batchStopJobRun = yield* AWS.Glue.BatchStopJobRun(job);

// runtime
const { SuccessfulSubmissions, Errors } = yield* batchStopJobRun({
  JobRunIds: [runId],
});
```

@binding

## BatchUpdatePartition

Runtime binding for `glue:BatchUpdatePartition`.

Rewrites up to 100 partitions of the bound {@link Table} in one call — the
bulk variant of `UpdatePartition`. Per-partition failures come back in the
response's `Errors` list. The database/table names and catalog id are
injected from the binding. Provide the implementation with
`Effect.provide(AWS.Glue.BatchUpdatePartitionHttp)`.
### Managing Partitions
**Example:** Bulk-Update Partition Parameters
```typescript
// init
const batchUpdatePartition = yield* AWS.Glue.BatchUpdatePartition(table);

// runtime
const { Errors } = yield* batchUpdatePartition({
  Entries: [
    {
      PartitionValueList: ["2026-01-01"],
      PartitionInput: {
        Values: ["2026-01-01"],
        Parameters: { compacted: "true" },
      },
    },
  ],
});
```

@binding

## CreatePartition

Runtime binding for `glue:CreatePartition`.

Registers a new partition on the bound {@link Table} — the write half of
the classic "data landed in S3, register the partition so Athena sees it"
pipeline. Fails with the typed `AlreadyExistsException` if the partition
is already registered. The database/table names and catalog id are
injected from the binding. Provide the implementation with
`Effect.provide(AWS.Glue.CreatePartitionHttp)`.
### Managing Partitions
**Example:** Register a New Partition
```typescript
// init
const createPartition = yield* AWS.Glue.CreatePartition(table);

// runtime — idempotent registration
yield* createPartition({
  PartitionInput: {
    Values: ["2026-01-01"],
    StorageDescriptor: { Location: "s3://my-data-lake/events/dt=2026-01-01/" },
  },
}).pipe(Effect.catchTag("AlreadyExistsException", () => Effect.void));
```

@binding

## DeletePartition

Runtime binding for `glue:DeletePartition`.

Deregisters one partition of the bound {@link Table} by its partition
values (the underlying data is untouched). Fails with the typed
`EntityNotFoundException` when the partition is already gone. The
database/table names and catalog id are injected from the binding.
Provide the implementation with
`Effect.provide(AWS.Glue.DeletePartitionHttp)`.
### Managing Partitions
**Example:** Deregister a Partition
```typescript
// init
const deletePartition = yield* AWS.Glue.DeletePartition(table);

// runtime — idempotent removal
yield* deletePartition({ PartitionValues: ["2026-01-01"] }).pipe(
  Effect.catchTag("EntityNotFoundException", () => Effect.void),
);
```

@binding

## GetCrawler

Runtime binding for `glue:GetCrawler`.

Reads the bound {@link Crawler}'s metadata — most usefully its `State`
(`READY`, `RUNNING`, `STOPPING`) and `LastCrawl` outcome — so runtime code
can poll a crawl started with `StartCrawler` to completion. The crawler
name is injected from the binding. Provide the implementation with
`Effect.provide(AWS.Glue.GetCrawlerHttp)`.
### Running Crawlers
**Example:** Poll a Crawl to Completion
```typescript
// init
const startCrawler = yield* AWS.Glue.StartCrawler(crawler);
const getCrawler = yield* AWS.Glue.GetCrawler(crawler);

// runtime
yield* startCrawler();
const done = yield* getCrawler().pipe(
  Effect.repeat({
    schedule: Schedule.spaced("10 seconds"),
    until: (r) => r.Crawler?.State === "READY",
    times: 8,
  }),
);
```

@binding

## GetJobBookmark

Runtime binding for `glue:GetJobBookmark`.

Reads the bound {@link Job}'s bookmark entry — the incremental-processing
checkpoint Glue keeps when a job runs with `--job-bookmark-option
job-bookmark-enable`. Fails with the typed `EntityNotFoundException` when
the job has never recorded a bookmark. The job name is injected from the
binding. Provide the implementation with
`Effect.provide(AWS.Glue.GetJobBookmarkHttp)`.
### Job Bookmarks
**Example:** Read the Bookmark
```typescript
// init
const getJobBookmark = yield* AWS.Glue.GetJobBookmark(job);

// runtime
const entry = yield* getJobBookmark().pipe(
  Effect.map((r) => r.JobBookmarkEntry),
  Effect.catchTag("EntityNotFoundException", () =>
    Effect.succeed(undefined),
  ),
);
```

@binding

## GetJobRun

Runtime binding for `glue:GetJobRun`.

Reads the metadata of a single run of the bound {@link Job} — its
`JobRunState` (`RUNNING`, `SUCCEEDED`, `FAILED`, `TIMEOUT`, …), timings,
and error message — so a function can poll a run it started to a terminal
state. The job name is injected from the binding. Provide the
implementation with `Effect.provide(AWS.Glue.GetJobRunHttp)`.
### Running Jobs
**Example:** Poll a Run to a Terminal State
```typescript
// init
const getJobRun = yield* AWS.Glue.GetJobRun(job);

// runtime
const { JobRun } = yield* getJobRun({ RunId: runId });
if (JobRun?.JobRunState === "FAILED") {
  yield* Effect.logError(JobRun.ErrorMessage ?? "run failed");
}
```

@binding

## GetJobRuns

Runtime binding for `glue:GetJobRuns`.

Lists the runs of the bound {@link Job} (newest first, paginated via
`NextToken`), so a function can report run history or find in-flight runs.
The job name is injected from the binding. Provide the implementation with
`Effect.provide(AWS.Glue.GetJobRunsHttp)`.
### Running Jobs
**Example:** List Recent Runs
```typescript
// init
const getJobRuns = yield* AWS.Glue.GetJobRuns(job);

// runtime
const { JobRuns } = yield* getJobRuns({ MaxResults: 10 });
const running = (JobRuns ?? []).filter(
  (run) => run.JobRunState === "RUNNING",
);
```

@binding

## GetPartition

Runtime binding for `glue:GetPartition`.

Reads a single partition of the bound {@link Table} by its partition
values. Fails with the typed `EntityNotFoundException` when the partition
does not exist. The database/table names and catalog id are injected from
the binding. Provide the implementation with
`Effect.provide(AWS.Glue.GetPartitionHttp)`.
### Managing Partitions
**Example:** Read One Partition
```typescript
// init
const getPartition = yield* AWS.Glue.GetPartition(table);

// runtime
const { Partition } = yield* getPartition({
  PartitionValues: ["2026-01-01"],
});
```

@binding

## GetPartitions

Runtime binding for `glue:GetPartitions`.

Lists the bound {@link Table}'s partitions, optionally filtered with a
partition-predicate `Expression` (e.g. `dt >= '2026-01-01'`) and paginated
via `NextToken`. The database/table names and catalog id are injected from
the binding. Provide the implementation with
`Effect.provide(AWS.Glue.GetPartitionsHttp)`.
### Managing Partitions
**Example:** List Recent Partitions
```typescript
// init
const getPartitions = yield* AWS.Glue.GetPartitions(table);

// runtime
const { Partitions } = yield* getPartitions({
  Expression: "dt >= '2026-01-01'",
});
```

@binding

## GetTable

Runtime binding for `glue:GetTable`.

Reads the bound {@link Table}'s full catalog definition — columns, storage
descriptor, partition keys, and parameters — so a function can introspect
the schema it is writing against. The database/table names and catalog id
are injected from the binding. Provide the implementation with
`Effect.provide(AWS.Glue.GetTableHttp)`.
### Reading the Data Catalog
**Example:** Introspect the Table Schema
```typescript
// init
const getTable = yield* AWS.Glue.GetTable(table);

// runtime
const { Table } = yield* getTable();
const columns = Table?.StorageDescriptor?.Columns ?? [];
```

@binding

## GetTables

Runtime binding for `glue:GetTables`.

Lists the table definitions of the bound {@link Database} (optionally
filtered by an `Expression` pattern, paginated via `NextToken`) — runtime
schema discovery over the Data Catalog. The database name and catalog id
are injected from the binding. Provide the implementation with
`Effect.provide(AWS.Glue.GetTablesHttp)`.
### Reading the Data Catalog
**Example:** Enumerate a Database's Tables
```typescript
// init
const getTables = yield* AWS.Glue.GetTables(database);

// runtime
const { TableList } = yield* getTables({ Expression: "events_*" });
const names = (TableList ?? []).map((t) => t.Name);
```

@binding

## ResetJobBookmark

Runtime binding for `glue:ResetJobBookmark`.

Resets the bound {@link Job}'s bookmark entry so the next bookmarked run
reprocesses the source data from the beginning — the standard remediation
after a bad deploy consumed data incorrectly. The job name is injected
from the binding. Provide the implementation with
`Effect.provide(AWS.Glue.ResetJobBookmarkHttp)`.
### Job Bookmarks
**Example:** Reset the Bookmark
```typescript
// init
const resetJobBookmark = yield* AWS.Glue.ResetJobBookmark(job);

// runtime
yield* resetJobBookmark();
```

@binding

## StartCrawler

Runtime binding for `glue:StartCrawler`.

Starts a crawl of the bound {@link Crawler} on demand — the standard way
to refresh the Data Catalog right after new data lands. Fails with the
typed `CrawlerRunningException` if a crawl is already in progress. The
crawler name is injected from the binding. Provide the implementation with
`Effect.provide(AWS.Glue.StartCrawlerHttp)`.
### Running Crawlers
**Example:** Kick Off a Crawl
```typescript
// init
const startCrawler = yield* AWS.Glue.StartCrawler(crawler);

// runtime — tolerate an already-running crawl
yield* startCrawler().pipe(
  Effect.catchTag("CrawlerRunningException", () => Effect.void),
);
```

@binding

## StartJobRun

Starts a run of a Glue job definition.

Grants `glue:StartJobRun` and `glue:GetJobRun` on the bound job. Returns the
`JobRunId`; poll `getJobRun` for the run's terminal state (`SUCCEEDED`,
`FAILED`, `TIMEOUT`, …).
### Running Jobs
Provide the `StartJobRunHttp` implementation layer on the Function effect
(`.pipe(Effect.provide(AWS.Glue.StartJobRunHttp))`), bind the job in the
init phase, then start runs at runtime.

**Example:** Start a job run from a handler
```typescript
// init
const startJobRun = yield* AWS.Glue.StartJobRun(job);

return {
  fetch: Effect.gen(function* () {
    // runtime
    const { JobRunId } = yield* startJobRun({
      Arguments: { "--input": "s3://my-bucket/input/" },
    });
    return HttpServerResponse.json({ JobRunId });
  }),
};
```

@binding

## StopCrawler

Runtime binding for `glue:StopCrawler`.

Stops an in-progress crawl of the bound {@link Crawler}. Fails with the
typed `CrawlerNotRunningException` when idle and
`CrawlerStoppingException` when a stop is already underway. The crawler
name is injected from the binding. Provide the implementation with
`Effect.provide(AWS.Glue.StopCrawlerHttp)`.
### Running Crawlers
**Example:** Stop a Crawl
```typescript
// init
const stopCrawler = yield* AWS.Glue.StopCrawler(crawler);

// runtime — tolerate an idle or already-stopping crawler
yield* stopCrawler().pipe(
  Effect.catchTag(
    ["CrawlerNotRunningException", "CrawlerStoppingException"],
    () => Effect.void,
  ),
);
```

@binding

## UpdatePartition

Runtime binding for `glue:UpdatePartition`.

Replaces the definition of one partition of the bound {@link Table} —
`PartitionValueList` addresses the existing partition and
`PartitionInput` is its new definition (location, parameters, schema).
The database/table names and catalog id are injected from the binding.
Provide the implementation with
`Effect.provide(AWS.Glue.UpdatePartitionHttp)`.
### Managing Partitions
**Example:** Move a Partition's Location
```typescript
// init
const updatePartition = yield* AWS.Glue.UpdatePartition(table);

// runtime
yield* updatePartition({
  PartitionValueList: ["2026-01-01"],
  PartitionInput: {
    Values: ["2026-01-01"],
    StorageDescriptor: { Location: "s3://my-data-lake/v2/dt=2026-01-01/" },
  },
});
```

@binding
