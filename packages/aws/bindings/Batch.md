<!-- Docs for the generated AWS.Batch bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CancelJob

Cancel a queued AWS Batch job from runtime code. Jobs in `SUBMITTED`,
`PENDING`, or `RUNNABLE` state are cancelled; jobs that already progressed
to `STARTING`/`RUNNING` are NOT cancelled (use `TerminateJob` for those) —
the request still succeeds.

### Cancelling Jobs
**Example:** Cancel a queued job
```typescript
const cancelJob = yield* Batch.CancelJob(queue);
yield* cancelJob({ jobId, reason: "superseded" });
```

@binding

## DescribeJobs

Describe submitted AWS Batch jobs (status polling from runtime code).
`batch:DescribeJobs` has no resource-level IAM, so the policy is
service-scoped; the queue anchors the binding's identity.

### Describing Jobs
**Example:** Poll a job's status
```typescript
const describeJobs = yield* Batch.DescribeJobs(queue);
const { jobs } = yield* describeJobs({ jobs: [jobId] });
const status = jobs?.[0]?.status;
```

@binding

## GetJobQueueSnapshot

Snapshot the head of the bound AWS Batch job queue (the next ~100 `RUNNABLE`
jobs the scheduler will run, in dispatch order) — queue introspection for
dashboards and backpressure decisions from runtime code.

### Inspecting the Queue
**Example:** Read the front of the queue
```typescript
const getJobQueueSnapshot = yield* Batch.GetJobQueueSnapshot(queue);
const { frontOfQueue } = yield* getJobQueueSnapshot();
const next = frontOfQueue?.jobs?.[0]?.jobArn;
```

@binding

## GetJobQueueSnapshot.Request

The queue is injected by the binding; the request carries nothing else.

## ListJobs

List AWS Batch jobs in the bound job queue from runtime code.
`batch:ListJobs` has no resource-level IAM, so the policy is
service-scoped; the queue anchors the binding and is injected as the
`jobQueue` selector.

### Listing Jobs
**Example:** List runnable jobs in the queue
```typescript
const listJobs = yield* Batch.ListJobs(queue);
const { jobSummaryList } = yield* listJobs({ jobStatus: "RUNNABLE" });
```

@binding

## ListJobs.Request

The queue is injected by the binding; filter by `jobStatus` (default
`RUNNING`), `filters`, or paginate with `nextToken`/`maxResults`.

## TerminateJob

Terminate a running (or cancel a queued) AWS Batch job from runtime code.

### Terminating Jobs
**Example:** Terminate a job
```typescript
const terminateJob = yield* Batch.TerminateJob(queue);
yield* terminateJob({ jobId, reason: "superseded" });
```

@binding
