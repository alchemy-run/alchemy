<!-- Docs for the generated AWS.Amplify bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CreateDeployment

Runtime binding for `amplify:CreateDeployment`.

Bind an {@link App} in the function's init phase to get a callable that
creates a manual deployment for a branch of an app with no connected
repository. The result carries pre-signed upload URLs (`zipUploadUrl`, or
per-file `fileUploadUrls` when a `fileMap` of MD5 hashes is supplied);
upload the content there, then release it with {@link StartDeployment}.
Provide the implementation with
`Effect.provide(AWS.Amplify.CreateDeploymentHttp)`.
### Manual Deployments
**Example:** Stage a Zip Deployment
```typescript
// init — bind the operation to the app
const createDeployment = yield* AWS.Amplify.CreateDeployment(app);

// runtime — obtain the upload URL for the deployment artifact
const { jobId, zipUploadUrl } = yield* createDeployment({
  branchName: "main",
});
// PUT the site zip to `zipUploadUrl`, then start the deployment with jobId
```

@binding

## DeleteJob

Runtime binding for `amplify:DeleteJob`.

Bind an {@link App} in the function's init phase to get a callable that
deletes a build job from a branch's history — e.g. a maintenance function
pruning old build records. Provide the implementation with
`Effect.provide(AWS.Amplify.DeleteJobHttp)`.
### Controlling Jobs
**Example:** Prune an Old Build Record
```typescript
// init — bind the operation to the app
const deleteJob = yield* AWS.Amplify.DeleteJob(app);

// runtime — remove the job from the branch's history
yield* deleteJob({ branchName: "main", jobId: "42" });
```

@binding

## GenerateAccessLogs

Runtime binding for `amplify:GenerateAccessLogs`.

Bind an {@link App} in the function's init phase to get a callable that
generates a pre-signed URL to the app's access logs for a time range —
e.g. an analytics function ingesting traffic data on a schedule. Provide the
implementation with `Effect.provide(AWS.Amplify.GenerateAccessLogsHttp)`.
### Reading Access Logs
**Example:** Pull the Last Day of Access Logs
```typescript
// init — bind the operation to the app
const generateAccessLogs = yield* AWS.Amplify.GenerateAccessLogs(app);

// runtime — logUrl is a pre-signed CSV download
const { logUrl } = yield* generateAccessLogs({
  domainName: "example.com",
  startTime: new Date(Date.now() - 24 * 60 * 60 * 1000),
  endTime: new Date(),
});
```

@binding

## GetJob

Runtime binding for `amplify:GetJob`.

Bind an {@link App} in the function's init phase to get a callable that
reads a build job — its summary and per-step logs/status — for one of the
app's branches. Provide the implementation with
`Effect.provide(AWS.Amplify.GetJobHttp)`.
### Observing Jobs
**Example:** Poll a Job Until It Settles
```typescript
// init — bind the operation to the app
const getJob = yield* AWS.Amplify.GetJob(app);

// runtime — read the job's current status
const { job } = yield* getJob({ branchName: "main", jobId: "42" });
if (job.summary.status === "FAILED") {
  yield* Effect.log(`build failed: ${job.summary.jobId}`);
}
```

@binding

## ListArtifacts

Runtime binding for `amplify:ListArtifacts`.

Bind an {@link App} in the function's init phase to get a callable that
lists the artifacts (e.g. test reports) a build job produced. Fetch an
individual artifact with {@link GetArtifactUrl}. Provide the implementation
with `Effect.provide(AWS.Amplify.ListArtifactsHttp)`.
### Reading Artifacts
**Example:** List a Job's Artifacts
```typescript
// init — bind the operation to the app
const listArtifacts = yield* AWS.Amplify.ListArtifacts(app);

// runtime
const { artifacts } = yield* listArtifacts({
  branchName: "main",
  jobId: "42",
});
```

@binding

## ListJobs

Runtime binding for `amplify:ListJobs`.

Bind an {@link App} in the function's init phase to get a callable that
lists the build jobs of one of the app's branches, newest first. Provide the
implementation with `Effect.provide(AWS.Amplify.ListJobsHttp)`.
### Observing Jobs
**Example:** Read the Latest Job of a Branch
```typescript
// init — bind the operation to the app
const listJobs = yield* AWS.Amplify.ListJobs(app);

// runtime — the first summary is the most recent job
const { jobSummaries } = yield* listJobs({
  branchName: "main",
  maxResults: 1,
});
const latest = jobSummaries[0];
```

@binding

## StartDeployment

Runtime binding for `amplify:StartDeployment`.

Bind an {@link App} in the function's init phase to get a callable that
releases a manual deployment on a branch of an app with no connected
repository — either a deployment staged with {@link CreateDeployment}
(`jobId`) or content fetched from a public `sourceUrl` (zip URL or S3
prefix). Provide the implementation with
`Effect.provide(AWS.Amplify.StartDeploymentHttp)`.
### Manual Deployments
**Example:** Release a Staged Deployment
```typescript
// init — bind the operation to the app
const startDeployment = yield* AWS.Amplify.StartDeployment(app);

// runtime — release the artifact uploaded via CreateDeployment
const { jobSummary } = yield* startDeployment({
  branchName: "main",
  jobId,
});
```

**Example:** Deploy Directly from an S3 Prefix
```typescript
const { jobSummary } = yield* startDeployment({
  branchName: "main",
  sourceUrl: "s3://my-site-artifacts/latest/",
  sourceUrlType: "BUCKET_PREFIX",
});
```

@binding

## StartJob

Runtime binding for `amplify:StartJob`.

Bind an {@link App} in the function's init phase to get a callable that
starts a build/deploy job for one of the app's branches — the app id is
injected automatically and `amplify:StartJob` is granted on the app's jobs.
Provide the implementation with `Effect.provide(AWS.Amplify.StartJobHttp)`.

The canonical use is a webhook Lambda that rebuilds the site when upstream
content changes (a CMS publish, a data refresh, etc.).
### Starting Jobs
**Example:** Rebuild a Branch on Content Change
```typescript
// init — bind the operation to the app
const startJob = yield* AWS.Amplify.StartJob(app);

// runtime — kick off a release of the main branch
const { jobSummary } = yield* startJob({
  branchName: "main",
  jobType: "RELEASE",
  jobReason: "CMS content published",
});
```

@binding

## StopJob

Runtime binding for `amplify:StopJob`.

Bind an {@link App} in the function's init phase to get a callable that
cancels an in-progress build job on one of the app's branches. Provide the
implementation with `Effect.provide(AWS.Amplify.StopJobHttp)`.
### Controlling Jobs
**Example:** Cancel a Running Build
```typescript
// init — bind the operation to the app
const stopJob = yield* AWS.Amplify.StopJob(app);

// runtime — cancel the job
const { jobSummary } = yield* stopJob({
  branchName: "main",
  jobId: "42",
});
```

@binding
