<!-- Docs for the generated AWS.MediaConvert bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CancelJob

Runtime binding for `mediaconvert:CancelJob` — permanently cancel a
submitted transcode job that has not finished (canceled jobs cannot be
restarted).

Job ids are server-assigned at runtime, so the binding takes no arguments
and grants `mediaconvert:CancelJob` on `*`. Provide the implementation
with `Effect.provide(AWS.MediaConvert.CancelJobHttp)`.

### Tracking Jobs
**Example:** Cancel an In-Flight Job
```typescript
// init
const cancelJob = yield* AWS.MediaConvert.CancelJob();

// runtime
yield* cancelJob({ Id: jobId }).pipe(
  // already finished / already gone — nothing to cancel
  Effect.catchTag(["NotFoundException", "ConflictException"], () => Effect.void),
);
```

@binding

## CreateJob

Runtime binding for `mediaconvert:CreateJob` — submit a transcode job from
runtime code, the classic "S3 upload event → Lambda → transcode" workflow.
Also grants `iam:PassRole` (conditioned to `mediaconvert.amazonaws.com`)
for the S3-access role the job passes to the service.

Job ids are server-assigned at runtime, so the binding takes no arguments
and grants `mediaconvert:CreateJob` on `*`. Provide the implementation
with `Effect.provide(AWS.MediaConvert.CreateJobHttp)`.

### Submitting Jobs
**Example:** Transcode an Uploaded File
```typescript
// init
const createJob = yield* AWS.MediaConvert.CreateJob();

// runtime
const { Job } = yield* createJob({
  Role: roleArn,
  JobTemplate: template.jobTemplateName,
  Settings: { Inputs: [{ FileInput: `s3://${bucket}/${key}` }] },
});
```

@binding

## GetJob

Runtime binding for `mediaconvert:GetJob` — poll the status and full JSON
of a submitted transcode job from runtime code.

Job ids are server-assigned at runtime, so the binding takes no arguments
and grants `mediaconvert:GetJob` on `*`. Provide the implementation with
`Effect.provide(AWS.MediaConvert.GetJobHttp)`.

### Tracking Jobs
**Example:** Poll a Job's Status
```typescript
// init
const getJob = yield* AWS.MediaConvert.GetJob();

// runtime
const { Job } = yield* getJob({ Id: jobId });
if (Job?.Status === "COMPLETE") { ... }
```

@binding

## GetJobsQueryResults

Runtime binding for `mediaconvert:GetJobsQueryResults` — fetch the results
of an asynchronous jobs query started with {@link StartJobsQuery}.

The binding takes no arguments and grants
`mediaconvert:GetJobsQueryResults` on `*`. Provide the implementation with
`Effect.provide(AWS.MediaConvert.GetJobsQueryResultsHttp)`.

### Tracking Jobs
**Example:** Fetch Query Results
```typescript
// init
const getJobsQueryResults = yield* AWS.MediaConvert.GetJobsQueryResults();

// runtime
const results = yield* getJobsQueryResults({ Id: queryId });
if (results.Status === "COMPLETE") {
  const jobs = results.Jobs ?? [];
}
```

@binding

## ListJobs

Runtime binding for `mediaconvert:ListJobs` — list your most recent
transcode jobs from runtime code, optionally filtered by queue or status.

The binding takes no arguments and grants `mediaconvert:ListJobs` on `*`.
Provide the implementation with
`Effect.provide(AWS.MediaConvert.ListJobsHttp)`.

### Tracking Jobs
**Example:** List In-Flight Jobs
```typescript
// init
const listJobs = yield* AWS.MediaConvert.ListJobs();

// runtime
const { Jobs } = yield* listJobs({ Status: "PROGRESSING" });
```

@binding

## Probe

Runtime binding for `mediaconvert:Probe` — analyze an input media file in
S3 (or over HTTPS) and get back its container, codecs, frame rate,
resolution, track layout, and captions, to drive transcoding decisions at
runtime.

The binding takes no arguments and grants `mediaconvert:Probe` on `*`.
Note the probing itself reads the file with the *caller's* credentials —
the Function also needs S3 read access to the probed object (bind an
`AWS.S3.GetObject` capability on the bucket).
Provide the implementation with `Effect.provide(AWS.MediaConvert.ProbeHttp)`.

### Inspecting Inputs
**Example:** Probe an Uploaded File
```typescript
// init
const probe = yield* AWS.MediaConvert.Probe();

// runtime
const { ProbeResults } = yield* probe({
  InputFiles: [{ FileUrl: `s3://${bucket}/${key}` }],
});
const video = ProbeResults?.[0]?.TrackMappings;
```

@binding

## SearchJobs

Runtime binding for `mediaconvert:SearchJobs` — search your recent
transcode jobs by input file, queue, or status from runtime code (e.g.
"did we already transcode this upload?").

The binding takes no arguments and grants `mediaconvert:SearchJobs` on
`*`. Provide the implementation with
`Effect.provide(AWS.MediaConvert.SearchJobsHttp)`.

### Tracking Jobs
**Example:** Find Jobs for an Input File
```typescript
// init
const searchJobs = yield* AWS.MediaConvert.SearchJobs();

// runtime
const { Jobs } = yield* searchJobs({
  InputFile: `s3://${bucket}/${key}`,
  Status: "COMPLETE",
});
```

@binding

## StartJobsQuery

Runtime binding for `mediaconvert:StartJobsQuery` — start an asynchronous,
filtered query over your job history (the async counterpart of
`SearchJobs` for larger result sets). Retrieve the results with
{@link GetJobsQueryResults} using the returned query `Id`.

The binding takes no arguments and grants `mediaconvert:StartJobsQuery`
on `*`. Provide the implementation with
`Effect.provide(AWS.MediaConvert.StartJobsQueryHttp)`.

### Tracking Jobs
**Example:** Query Errored Jobs
```typescript
// init
const startJobsQuery = yield* AWS.MediaConvert.StartJobsQuery();

// runtime
const { Id } = yield* startJobsQuery({
  FilterList: [{ Type: "STATUS", Inputs: ["ERROR"] }],
});
```

@binding
