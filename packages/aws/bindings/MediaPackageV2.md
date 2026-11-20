<!-- Docs for the generated AWS.MediaPackageV2 bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CancelHarvestJob

Runtime binding for `mediapackagev2:CancelHarvestJob`.

Cancels a queued or in-progress harvest job on the bound
{@link OriginEndpoint} — e.g. aborting a clip export the operator
withdrew. The endpoint's group, channel, and name are injected from the
binding. Provide the implementation with
`Effect.provide(AWS.MediaPackageV2.CancelHarvestJobHttp)`.
### Harvesting Live-to-VOD Clips
**Example:** Cancel an In-Progress Harvest Job
```typescript
// init — bind the operation to the endpoint
const cancelHarvestJob = yield* AWS.MediaPackageV2.CancelHarvestJob(endpoint);

// runtime
yield* cancelHarvestJob({ HarvestJobName: job.HarvestJobName });
```

@binding

## CreateHarvestJob

Runtime binding for `mediapackagev2:CreateHarvestJob`.

Exports a clip of previously streamed content from the bound
{@link OriginEndpoint} to an S3 bucket as a live-to-VOD asset — e.g. a
Lambda that clips a highlight when an operator flags a moment. The
endpoint must have a startover window covering the requested schedule,
and the destination bucket needs a policy granting the
`mediapackagev2.amazonaws.com` service principal write access. The
endpoint's group, channel, and name are injected from the binding.
Provide the implementation with
`Effect.provide(AWS.MediaPackageV2.CreateHarvestJobHttp)`.
### Harvesting Live-to-VOD Clips
**Example:** Harvest the Last Five Minutes to S3
```typescript
// init — bind the operation to the endpoint
const createHarvestJob = yield* AWS.MediaPackageV2.CreateHarvestJob(endpoint);

// runtime
const job = yield* createHarvestJob({
  HarvestedManifests: { HlsManifests: [{ ManifestName: "index" }] },
  ScheduleConfiguration: {
    StartTime: new Date(Date.now() - 5 * 60_000),
    EndTime: new Date(),
  },
  Destination: {
    S3Destination: { BucketName: "my-clips", DestinationPath: "highlights/" },
  },
});
```

@binding

## GetHarvestJob

Runtime binding for `mediapackagev2:GetHarvestJob`.

Reads the status of a harvest job on the bound {@link OriginEndpoint} —
e.g. polling until a clip export reaches `COMPLETED` before publishing
the VOD asset. The endpoint's group, channel, and name are injected from
the binding. Provide the implementation with
`Effect.provide(AWS.MediaPackageV2.GetHarvestJobHttp)`.
### Harvesting Live-to-VOD Clips
**Example:** Poll a Harvest Job Until It Completes
```typescript
// init — bind the operation to the endpoint
const getHarvestJob = yield* AWS.MediaPackageV2.GetHarvestJob(endpoint);

// runtime
const { Status } = yield* getHarvestJob({ HarvestJobName: job.HarvestJobName });
```

@binding

## ListHarvestJobs

Runtime binding for `mediapackagev2:ListHarvestJobs`.

Enumerates the harvest jobs in the bound {@link ChannelGroup}, optionally
filtered by channel, endpoint, or status — e.g. a dashboard Lambda
listing in-progress clip exports. The group's name is injected from the
binding. Provide the implementation with
`Effect.provide(AWS.MediaPackageV2.ListHarvestJobsHttp)`.
### Harvesting Live-to-VOD Clips
**Example:** List the Group's Queued Harvest Jobs
```typescript
// init — bind the operation to the channel group
const listHarvestJobs = yield* AWS.MediaPackageV2.ListHarvestJobs(group);

// runtime
const { Items } = yield* listHarvestJobs({ Status: "QUEUED" });
```

@binding

## ResetChannelState

Runtime binding for `mediapackagev2:ResetChannelState`.

Resets the ingest state of the bound {@link Channel} — clearing buffered
content so the encoder can re-push a clean stream after a corrupted
contribution (e.g. an ops Lambda recovering a broken live event). The
channel's group and name are injected from the binding. Provide the
implementation with
`Effect.provide(AWS.MediaPackageV2.ResetChannelStateHttp)`.
### Resetting Ingest State
**Example:** Reset a Channel After a Corrupted Contribution
```typescript
// init — bind the operation to the channel
const resetChannel = yield* AWS.MediaPackageV2.ResetChannelState(channel);

// runtime
const { ResetAt } = yield* resetChannel();
```

@binding

## ResetOriginEndpointState

Runtime binding for `mediapackagev2:ResetOriginEndpointState`.

Resets the packaging state of the bound {@link OriginEndpoint} — clearing
its manifests and cached segments so playback restarts clean after the
channel's content was reset or replaced. The endpoint's group, channel,
and name are injected from the binding. Provide the implementation with
`Effect.provide(AWS.MediaPackageV2.ResetOriginEndpointStateHttp)`.
### Resetting Ingest State
**Example:** Reset an Endpoint After Resetting Its Channel
```typescript
// init — bind the operation to the endpoint
const resetEndpoint =
  yield* AWS.MediaPackageV2.ResetOriginEndpointState(endpoint);

// runtime
const { ResetAt } = yield* resetEndpoint();
```

@binding
