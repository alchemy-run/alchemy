<!-- Docs for the generated AWS.MediaTailor bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CreatePrefetchSchedule

Runtime binding for `mediatailor:CreatePrefetchSchedule` — tell MediaTailor
to fetch and prepare ads for upcoming ad breaks ahead of time (e.g. right
before a live event's scheduled break) so avails fill without ADS latency.

The bound {@link PlaybackConfiguration}'s name is injected; the grant is
scoped to that configuration's prefetch-schedule ARN space. Provide the
implementation with `Effect.provide(AWS.MediaTailor.CreatePrefetchScheduleHttp)`.

### Prefetching Ads
**Example:** Prefetch ads for an upcoming break
```typescript
const createPrefetchSchedule = yield* AWS.MediaTailor.CreatePrefetchSchedule(config);

const schedule = yield* createPrefetchSchedule({
  Name: `event-${eventId}`,
  Retrieval: { EndTime: retrievalDeadline },
  Consumption: { EndTime: breakEnd },
});
```

@binding

## CreatePrefetchSchedule.Request

`CreatePrefetchSchedule` request with `PlaybackConfigurationName` injected
from the bound {@link PlaybackConfiguration}.

## CreateProgram

Runtime binding for `mediatailor:CreateProgram` — schedule a VOD or live
source as a program on a channel-assembly channel. Dynamic program
scheduling is the core runtime workflow of channel assembly: applications
insert programs into a linear channel's schedule as content becomes
available.

Channel/program names are runtime parameters, so the binding is
account-level and grants `mediatailor:CreateProgram` on `*`. Provide the
implementation with `Effect.provide(AWS.MediaTailor.CreateProgramHttp)`.

### Channel Assembly
**Example:** Append a VOD source to a channel
```typescript
const createProgram = yield* AWS.MediaTailor.CreateProgram();

yield* createProgram({
  ChannelName: "my-channel",
  ProgramName: `episode-${id}`,
  SourceLocationName: "my-origin",
  VodSourceName: "episode-1",
  ScheduleConfiguration: { Transition: { Type: "RELATIVE", RelativePosition: "AFTER_PROGRAM" } },
});
```

@binding

## DeletePrefetchSchedule

Runtime binding for `mediatailor:DeletePrefetchSchedule` — remove a
prefetch schedule from the bound {@link PlaybackConfiguration} (e.g. when
a live event is cancelled).

Provide the implementation with
`Effect.provide(AWS.MediaTailor.DeletePrefetchScheduleHttp)`.

### Prefetching Ads
**Example:** Delete a prefetch schedule
```typescript
const deletePrefetchSchedule = yield* AWS.MediaTailor.DeletePrefetchSchedule(config);

yield* deletePrefetchSchedule({ Name: `event-${eventId}` });
```

@binding

## DeletePrefetchSchedule.Request

`DeletePrefetchSchedule` request with `PlaybackConfigurationName` injected
from the bound {@link PlaybackConfiguration}.

## DeleteProgram

Runtime binding for `mediatailor:DeleteProgram` — remove a scheduled
program from a channel-assembly channel.

Channel/program names are runtime parameters, so the binding is
account-level and grants `mediatailor:DeleteProgram` on `*`. Provide the
implementation with `Effect.provide(AWS.MediaTailor.DeleteProgramHttp)`.

### Channel Assembly
**Example:** Remove a program from the schedule
```typescript
const deleteProgram = yield* AWS.MediaTailor.DeleteProgram();

yield* deleteProgram({
  ChannelName: "my-channel",
  ProgramName: `episode-${id}`,
});
```

@binding

## DescribeProgram

Runtime binding for `mediatailor:DescribeProgram` — read a scheduled
program on a channel-assembly channel.

Channel/program names are runtime parameters, so the binding is
account-level and grants `mediatailor:DescribeProgram` on `*`. Provide the
implementation with `Effect.provide(AWS.MediaTailor.DescribeProgramHttp)`.

### Channel Assembly
**Example:** Read a scheduled program
```typescript
const describeProgram = yield* AWS.MediaTailor.DescribeProgram();

const program = yield* describeProgram({
  ChannelName: "my-channel",
  ProgramName: `episode-${id}`,
});
```

@binding

## GetChannelSchedule

Runtime binding for `mediatailor:GetChannelSchedule` — read the current
schedule (programs + ad breaks) of a channel-assembly channel.

Channel names are runtime parameters, so the binding is account-level and
grants `mediatailor:GetChannelSchedule` on `*`. Provide the implementation
with `Effect.provide(AWS.MediaTailor.GetChannelScheduleHttp)`.

### Channel Assembly
**Example:** Read a channel's schedule
```typescript
const getChannelSchedule = yield* AWS.MediaTailor.GetChannelSchedule();

const { Items } = yield* getChannelSchedule({ ChannelName: "my-channel" });
```

@binding

## GetPrefetchSchedule

Runtime binding for `mediatailor:GetPrefetchSchedule` — read a prefetch
schedule on the bound {@link PlaybackConfiguration} by name.

Provide the implementation with
`Effect.provide(AWS.MediaTailor.GetPrefetchScheduleHttp)`.

### Prefetching Ads
**Example:** Read a prefetch schedule
```typescript
const getPrefetchSchedule = yield* AWS.MediaTailor.GetPrefetchSchedule(config);

const schedule = yield* getPrefetchSchedule({ Name: `event-${eventId}` });
```

@binding

## GetPrefetchSchedule.Request

`GetPrefetchSchedule` request with `PlaybackConfigurationName` injected
from the bound {@link PlaybackConfiguration}.

## ListAlerts

Runtime binding for `mediatailor:ListAlerts` — read the operational alerts
MediaTailor raises for a channel-assembly resource (channel, source
location, VOD/live source) identified by ARN.

Resource ARNs are runtime parameters, so the binding is account-level and
grants `mediatailor:ListAlerts` on `*`. Provide the implementation with
`Effect.provide(AWS.MediaTailor.ListAlertsHttp)`.

### Channel Assembly
**Example:** Check a channel for alerts
```typescript
const listAlerts = yield* AWS.MediaTailor.ListAlerts();

const { Items } = yield* listAlerts({ ResourceArn: channelArn });
```

@binding

## ListPrefetchSchedules

Runtime binding for `mediatailor:ListPrefetchSchedules` — page through the
prefetch schedules on the bound {@link PlaybackConfiguration}, optionally
filtered by `StreamId` or `ScheduleType`.

Provide the implementation with
`Effect.provide(AWS.MediaTailor.ListPrefetchSchedulesHttp)`.

### Prefetching Ads
**Example:** List prefetch schedules for a stream
```typescript
const listPrefetchSchedules = yield* AWS.MediaTailor.ListPrefetchSchedules(config);

const { Items } = yield* listPrefetchSchedules({ StreamId: streamId });
```

@binding

## ListPrefetchSchedules.Request

`ListPrefetchSchedules` request with `PlaybackConfigurationName` injected
from the bound {@link PlaybackConfiguration}.

## StartChannel

Runtime binding for `mediatailor:StartChannel` — start a channel-assembly
channel so it begins producing its linear stream.

Channel names are runtime parameters, so the binding is account-level and
grants `mediatailor:StartChannel` on `*`. Provide the implementation with
`Effect.provide(AWS.MediaTailor.StartChannelHttp)`.

### Channel Assembly
**Example:** Start a channel
```typescript
const startChannel = yield* AWS.MediaTailor.StartChannel();

yield* startChannel({ ChannelName: "my-channel" });
```

@binding

## StopChannel

Runtime binding for `mediatailor:StopChannel` — stop a running
channel-assembly channel.

Channel names are runtime parameters, so the binding is account-level and
grants `mediatailor:StopChannel` on `*`. Provide the implementation with
`Effect.provide(AWS.MediaTailor.StopChannelHttp)`.

### Channel Assembly
**Example:** Stop a channel
```typescript
const stopChannel = yield* AWS.MediaTailor.StopChannel();

yield* stopChannel({ ChannelName: "my-channel" });
```

@binding

## UpdateProgram

Runtime binding for `mediatailor:UpdateProgram` — move or re-configure a
scheduled program on a channel-assembly channel (e.g. change its
transition or ad breaks) before it plays.

Channel/program names are runtime parameters, so the binding is
account-level and grants `mediatailor:UpdateProgram` on `*`. Provide the
implementation with `Effect.provide(AWS.MediaTailor.UpdateProgramHttp)`.

### Channel Assembly
**Example:** Reschedule a program
```typescript
const updateProgram = yield* AWS.MediaTailor.UpdateProgram();

yield* updateProgram({
  ChannelName: "my-channel",
  ProgramName: `episode-${id}`,
  ScheduleConfiguration: { Transition: { ScheduledStartTimeMillis: startAt } },
});
```

@binding
