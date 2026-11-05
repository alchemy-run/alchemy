<!-- Docs for the generated AWS.MediaLive bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## BatchUpdateSchedule

Runtime binding for `medialive:BatchUpdateSchedule`.

Adds and/or removes schedule actions on the bound {@link Channel} — ad
breaks (SCTE-35 splices), input switches, static image overlays, pause
states — the primary data-plane API for driving a live broadcast (e.g.
a playout-automation Lambda that switches inputs on a timecode). The
channel id is injected from the binding. Provide the implementation
with `Effect.provide(AWS.MediaLive.BatchUpdateScheduleHttp)`.
### Driving the Channel Schedule
**Example:** Schedule an Input Switch
```typescript
// init — bind the operation to the channel
const updateSchedule = yield* AWS.MediaLive.BatchUpdateSchedule(channel);

// runtime
yield* updateSchedule({
  Creates: {
    ScheduleActions: [
      {
        ActionName: "switch-to-backup",
        ScheduleActionStartSettings: {
          FixedModeScheduleActionStartSettings: {
            Time: "2026-01-01T00:00:00.000Z",
          },
        },
        ScheduleActionSettings: {
          InputSwitchSettings: { InputAttachmentNameReference: "backup" },
        },
      },
    ],
  },
});
```

@binding

## DeleteSchedule

Runtime binding for `medialive:DeleteSchedule`.

Clears every scheduled action from the bound {@link Channel}'s schedule
in one call — the reset lever a playout-automation Lambda pulls before
programming a fresh broadcast rundown with {@link BatchUpdateSchedule}.
The channel id is injected from the binding. Provide the implementation
with `Effect.provide(AWS.MediaLive.DeleteScheduleHttp)`.
### Driving the Channel Schedule
**Example:** Reset the Channel's Schedule
```typescript
// init — bind the operation to the channel
const deleteSchedule = yield* AWS.MediaLive.DeleteSchedule(channel);

// runtime
yield* deleteSchedule();
```

@binding

## DescribeChannel

Runtime binding for `medialive:DescribeChannel`.

Reads the bound {@link Channel}'s live state — lifecycle state
(`IDLE`/`RUNNING`), pipeline details, egress endpoints, and attached
inputs — e.g. for an operations dashboard or a scheduler that only
starts a channel that is not already running. The channel id is
injected from the binding. Provide the implementation with
`Effect.provide(AWS.MediaLive.DescribeChannelHttp)`.
### Observing Channels
**Example:** Read the Channel's Current State
```typescript
// init — bind the operation to the channel
const describeChannel = yield* AWS.MediaLive.DescribeChannel(channel);

// runtime
const { State } = yield* describeChannel();
const running = State === "RUNNING";
```

@binding

## DescribeInput

Runtime binding for `medialive:DescribeInput`.

Reads the bound {@link Input}'s live state — attachment state
(`DETACHED`/`ATTACHED`), resolved push ingest URLs, sources, and
security groups — e.g. so a stream-key service can hand a contributor
the RTMP endpoint to push to. The input id is injected from the
binding. Provide the implementation with
`Effect.provide(AWS.MediaLive.DescribeInputHttp)`.
### Observing Inputs
**Example:** Read the Input's Ingest Endpoints
```typescript
// init — bind the operation to the input
const describeInput = yield* AWS.MediaLive.DescribeInput(input);

// runtime
const { Destinations } = yield* describeInput();
const ingestUrl = Destinations?.[0]?.Url;
```

@binding

## DescribeSchedule

Runtime binding for `medialive:DescribeSchedule`.

Reads the bound {@link Channel}'s schedule — the queue of pending and
recent actions created with {@link BatchUpdateSchedule} (one page per
call; pass `NextToken` from the previous response to continue) — e.g.
so a playout dashboard can show upcoming input switches and ad breaks.
The channel id is injected from the binding. Provide the implementation
with `Effect.provide(AWS.MediaLive.DescribeScheduleHttp)`.
### Driving the Channel Schedule
**Example:** List the Channel's Scheduled Actions
```typescript
// init — bind the operation to the channel
const describeSchedule = yield* AWS.MediaLive.DescribeSchedule(channel);

// runtime
const { ScheduleActions } = yield* describeSchedule();
```

@binding

## DescribeThumbnails

Runtime binding for `medialive:DescribeThumbnails`.

Fetches the latest preview thumbnail (base64 JPEG) from a pipeline of
the bound RUNNING {@link Channel} — e.g. a confidence-monitoring
dashboard that renders a live snapshot of what the channel is encoding.
Requires thumbnails to be enabled in the channel's encoder settings; a
channel that is not running answers with the typed
`BadRequestException` tag. The channel id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.MediaLive.DescribeThumbnailsHttp)`.
### Observing Channels
**Example:** Fetch the Latest Preview Thumbnail
```typescript
// init — bind the operation to the channel
const describeThumbnails = yield* AWS.MediaLive.DescribeThumbnails(channel);

// runtime
const { ThumbnailDetails } = yield* describeThumbnails({
  PipelineId: "0",
  ThumbnailType: "CURRENT_ACTIVE",
});
```

@binding

## ListAlerts

Runtime binding for `medialive:ListAlerts`.

Lists the bound {@link Channel}'s alerts — SET and CLEARED error
conditions such as a lost input or a failed output (one page per call;
pass `NextToken` from the previous response to continue). Filter with
`StateFilter: "SET"` to see only active problems — e.g. a health-check
Lambda that pages an operator while any alert is SET. The channel id is
injected from the binding. Provide the implementation with
`Effect.provide(AWS.MediaLive.ListAlertsHttp)`.
### Observing Channels
**Example:** List the Channel's Active Alerts
```typescript
// init — bind the operation to the channel
const listAlerts = yield* AWS.MediaLive.ListAlerts(channel);

// runtime
const { Alerts } = yield* listAlerts({ StateFilter: "SET" });
```

@binding

## ListChannels

Runtime binding for `medialive:ListChannels`.

Enumerates the account's MediaLive channels (one page per call — pass
`NextToken` from the previous response to continue) — e.g. a cost
sentinel that finds channels left RUNNING outside broadcast hours.
Account-level: the deploy-time grant is `medialive:ListChannels` on
`*`. Provide the implementation with
`Effect.provide(AWS.MediaLive.ListChannelsHttp)`.
### Observing Channels
**Example:** Find Channels Left Running
```typescript
// init — bind the account-level operation
const listChannels = yield* AWS.MediaLive.ListChannels();

// runtime
const { Channels } = yield* listChannels({ MaxResults: 20 });
const running = (Channels ?? []).filter((c) => c.State === "RUNNING");
```

@binding

## ListInputs

Runtime binding for `medialive:ListInputs`.

Enumerates the account's MediaLive inputs (one page per call — pass
`NextToken` from the previous response to continue) — e.g. an
inventory endpoint that maps ingest endpoints to the channels they
feed. Account-level: the deploy-time grant is `medialive:ListInputs`
on `*`. Provide the implementation with
`Effect.provide(AWS.MediaLive.ListInputsHttp)`.
### Observing Inputs
**Example:** Enumerate the Account's Inputs
```typescript
// init — bind the account-level operation
const listInputs = yield* AWS.MediaLive.ListInputs();

// runtime
const { Inputs } = yield* listInputs({ MaxResults: 20 });
const attached = (Inputs ?? []).filter((i) => i.State === "ATTACHED");
```

@binding

## RestartChannelPipelines

Runtime binding for `medialive:RestartChannelPipelines`.

Restarts one or both encoder pipelines of the bound RUNNING
{@link Channel} without a full stop/start cycle — the standard remedy
for a wedged pipeline (frozen output, persistent alert) that an
automated-recovery Lambda applies when a channel alert fires. The
channel id is injected from the binding. Provide the implementation
with `Effect.provide(AWS.MediaLive.RestartChannelPipelinesHttp)`.
### Controlling Channels
**Example:** Restart a Wedged Pipeline
```typescript
// init — bind the operation to the channel
const restartPipelines = yield* AWS.MediaLive.RestartChannelPipelines(channel);

// runtime
yield* restartPipelines({ PipelineIds: ["PIPELINE_0"] });
```

@binding

## StartChannel

Runtime binding for `medialive:StartChannel`.

Starts the bound {@link Channel}, transitioning it from `IDLE` through
`STARTING` to `RUNNING`. A RUNNING channel encodes and bills hourly —
pair with {@link StopChannel} to control encoding cost (e.g. a
scheduler Lambda that runs the channel only during broadcast windows).
The channel id is injected from the binding. Provide the implementation
with `Effect.provide(AWS.MediaLive.StartChannelHttp)`.
### Controlling Channels
**Example:** Start the Channel for a Broadcast Window
```typescript
// init — bind the operation to the channel
const startChannel = yield* AWS.MediaLive.StartChannel(channel);

// runtime
const { State } = yield* startChannel();
```

@binding

## StopChannel

Runtime binding for `medialive:StopChannel`.

Stops the bound {@link Channel}, transitioning it from `RUNNING`
through `STOPPING` back to `IDLE` — the other half of a broadcast-window
scheduler built on {@link StartChannel}. Stopping a channel that is not
running fails with the typed `ConflictException` tag. The channel id is
injected from the binding. Provide the implementation with
`Effect.provide(AWS.MediaLive.StopChannelHttp)`.
### Controlling Channels
**Example:** Stop the Channel After the Broadcast
```typescript
// init — bind the operation to the channel
const stopChannel = yield* AWS.MediaLive.StopChannel(channel);

// runtime
const { State } = yield* stopChannel();
```

@binding
