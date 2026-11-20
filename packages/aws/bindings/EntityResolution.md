<!-- Docs for the generated AWS.EntityResolution bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## BatchDeleteUniqueId

Runtime binding for `entityresolution:BatchDeleteUniqueId`.

Deletes unique IDs (and their match associations) from the bound matching
workflow's internal match store. Provide the implementation with
`Effect.provide(AWS.EntityResolution.BatchDeleteUniqueIdHttp)`.
### Real-Time Matching
**Example:** Delete Records from the Match Store
```typescript
// init — bind the operation to the workflow
const batchDeleteUniqueId = yield* AWS.EntityResolution.BatchDeleteUniqueId(workflow);

// runtime
const { deleted, errors } = yield* batchDeleteUniqueId({
  uniqueIds: ["1", "2"],
});
```

@binding

## GenerateMatchId

Runtime binding for `entityresolution:GenerateMatchId`.

Generates or retrieves Match IDs for records submitted in real time
against the bound rule-based matching workflow: existing records return
their Match IDs, unmatched records get new ones. Provide the
implementation with `Effect.provide(AWS.EntityResolution.GenerateMatchIdHttp)`.
### Real-Time Matching
**Example:** Generate Match IDs for Records
```typescript
// init — bind the operation to the workflow
const generateMatchId = yield* AWS.EntityResolution.GenerateMatchId(workflow);

// runtime
const { matchGroups } = yield* generateMatchId({
  records: [
    {
      inputSourceARN: table.tableArn,
      uniqueId: "1",
      recordAttributeMap: { id: "1", email: "jane@example.com" },
    },
  ],
});
```

@binding

## GetIdMappingJob

Runtime binding for `entityresolution:GetIdMappingJob`.

Reads the status, metrics, and errors of an ID mapping job run of the
bound workflow. Provide the implementation with
`Effect.provide(AWS.EntityResolution.GetIdMappingJobHttp)`.
### Running ID Mapping Jobs
**Example:** Poll a Job's Status
```typescript
// init — bind the operation to the workflow
const getIdMappingJob = yield* AWS.EntityResolution.GetIdMappingJob(workflow);

// runtime
const job = yield* getIdMappingJob({ jobId });
console.log(job.status, job.metrics?.totalMappedRecords);
```

@binding

## GetMatchId

Runtime binding for `entityresolution:GetMatchId`.

Returns the Match ID of a customer record if it has already been processed
by the bound rule-based matching workflow — a read-only dry run of an
incremental load. Provide the implementation with
`Effect.provide(AWS.EntityResolution.GetMatchIdHttp)`.
### Real-Time Matching
**Example:** Look Up a Record's Match ID
```typescript
// init — bind the operation to the workflow
const getMatchId = yield* AWS.EntityResolution.GetMatchId(workflow);

// runtime
const { matchId, matchRule } = yield* getMatchId({
  record: { id: "1", email: "jane@example.com" },
});
```

@binding

## GetMatchingJob

Runtime binding for `entityresolution:GetMatchingJob`.

Reads the status, metrics, and errors of a matching job run of the bound
workflow. Provide the implementation with
`Effect.provide(AWS.EntityResolution.GetMatchingJobHttp)`.
### Running Matching Jobs
**Example:** Poll a Job's Status
```typescript
// init — bind the operation to the workflow
const getMatchingJob = yield* AWS.EntityResolution.GetMatchingJob(workflow);

// runtime
const job = yield* getMatchingJob({ jobId });
console.log(job.status, job.metrics?.matchIDs);
```

@binding

## ListIdMappingJobs

Runtime binding for `entityresolution:ListIdMappingJobs`.

Lists the ID mapping job runs of the bound workflow. Provide the
implementation with `Effect.provide(AWS.EntityResolution.ListIdMappingJobsHttp)`.
### Running ID Mapping Jobs
**Example:** List Recent Jobs
```typescript
// init — bind the operation to the workflow
const listIdMappingJobs = yield* AWS.EntityResolution.ListIdMappingJobs(workflow);

// runtime
const { jobs } = yield* listIdMappingJobs({});
```

@binding

## ListMatchingJobs

Runtime binding for `entityresolution:ListMatchingJobs`.

Lists the matching job runs of the bound workflow. Provide the
implementation with `Effect.provide(AWS.EntityResolution.ListMatchingJobsHttp)`.
### Running Matching Jobs
**Example:** List Recent Jobs
```typescript
// init — bind the operation to the workflow
const listMatchingJobs = yield* AWS.EntityResolution.ListMatchingJobs(workflow);

// runtime
const { jobs } = yield* listMatchingJobs({});
```

@binding

## StartIdMappingJob

Runtime binding for `entityresolution:StartIdMappingJob`.

Starts an ID mapping job run of the bound workflow — a batch process over
the workflow's full input that takes many minutes. Provide the
implementation with `Effect.provide(AWS.EntityResolution.StartIdMappingJobHttp)`.
### Running ID Mapping Jobs
**Example:** Start a Job
```typescript
// init — bind the operation to the workflow
const startIdMappingJob = yield* AWS.EntityResolution.StartIdMappingJob(workflow);

// runtime
const { jobId } = yield* startIdMappingJob({});
```

@binding

## StartMatchingJob

Runtime binding for `entityresolution:StartMatchingJob`.

Starts a matching job run of the bound workflow — a batch process over the
workflow's full input that takes many minutes. Provide the implementation
with `Effect.provide(AWS.EntityResolution.StartMatchingJobHttp)`.
### Running Matching Jobs
**Example:** Start a Job
```typescript
// init — bind the operation to the workflow
const startMatchingJob = yield* AWS.EntityResolution.StartMatchingJob(workflow);

// runtime
const { jobId } = yield* startMatchingJob({});
```

@binding
