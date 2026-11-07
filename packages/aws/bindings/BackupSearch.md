<!-- Docs for the generated AWS.BackupSearch bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## GetSearchJob

Runtime binding for `backup-search:GetSearchJob`.

Retrieves the bound search job's metadata and progress — its `Status`
(`RUNNING`, `COMPLETED`, `STOPPED`, `FAILED`), item/backup counts, and
completion time. BackupSearch emits no EventBridge events, so polling this
operation until `Status` is terminal is how a consumer knows the results
returned by `ListSearchJobResults` are final. Provide the implementation
with `Effect.provide(AWS.BackupSearch.GetSearchJobHttp)`.
### Polling Search Progress
**Example:** Wait for the Search Job to Complete
```typescript
// init — bind the operation to the search job
const getSearchJob = yield* AWS.BackupSearch.GetSearchJob(search);

// runtime — poll until the job reaches a terminal status
const job = yield* getSearchJob().pipe(
  Effect.repeat({
    schedule: Schedule.spaced("5 seconds"),
    until: (j) => j.Status !== "RUNNING",
    times: 24,
  }),
);
console.log(job.Status, job.SearchProgress?.ItemsMatchedCount);
```

@binding

## ListSearchJobBackups

Runtime binding for `backup-search:ListSearchJobBackups`.

Pages through the recovery points included in the bound search job, with
each backup's per-job status — including backups skipped because their
index is not `ACTIVE` or a permissions issue marked them `FAILED`. Provide
the implementation with
`Effect.provide(AWS.BackupSearch.ListSearchJobBackupsHttp)`.
### Reading Searched Backups
**Example:** List the Search Job's Backups
```typescript
// init — bind the operation to the search job
const listSearchJobBackups =
  yield* AWS.BackupSearch.ListSearchJobBackups(search);

// runtime
const page = yield* listSearchJobBackups({ MaxResults: 100 });
for (const backup of page.Results) {
  console.log(backup.BackupResourceArn, backup.Status);
}
```

@binding

## ListSearchJobBackups.Request

`ListSearchJobBackups` request with `SearchJobIdentifier` injected from the bound {@link SearchJob}.

## ListSearchJobResults

Runtime binding for `backup-search:ListSearchJobResults`.

Pages through the search results (matched S3 objects / EBS files) of the
bound search job. Results stream in while the job is `RUNNING` and are
retained for seven days after it completes. Provide the implementation
with `Effect.provide(AWS.BackupSearch.ListSearchJobResultsHttp)`.
### Reading Search Results
**Example:** List the Search Job's Results
```typescript
// init — bind the operation to the search job
const listSearchJobResults =
  yield* AWS.BackupSearch.ListSearchJobResults(search);

// runtime
const page = yield* listSearchJobResults({ MaxResults: 100 });
for (const item of page.Results) {
  if (item.S3ResultItem) console.log(item.S3ResultItem.BackupVaultName);
}
```

@binding

## ListSearchJobResults.Request

`ListSearchJobResults` request with `SearchJobIdentifier` injected from the bound {@link SearchJob}.
