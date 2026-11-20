<!-- Docs for the generated AWS.IVSRealtime bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DisconnectParticipant

Forcibly disconnect a participant from the bound stage — the moderation
call made from a deployed Lambda or Task. If the participant is publishing
via an ingest configuration, its `stageArn` attachment is also cleared.

### Moderating Participants
**Example:** Kick a participant from a Lambda
```typescript
// init
const disconnectParticipant = yield* IVSRealtime.DisconnectParticipant(stage);

// runtime
yield* disconnectParticipant({
  participantId: "abcDEF123",
  reason: "moderated",
});
```

@binding

## DisconnectParticipant.Request

The `stageArn` is injected by the binding from the bound stage.

## GetComposition

Read a composition's detail — state, layout, destinations, and per
destination progress. Compositions are addressed by the server-generated
ARN returned by `StartComposition`.

### Compositing a Stage
**Example:** Poll a composition's state
```typescript
// init
const getComposition = yield* IVSRealtime.GetComposition();

// runtime
const { composition } = yield* getComposition({ arn: compositionArn });
// composition.state → "ACTIVE" | "STOPPED" | "FAILED" | …
```

@binding

## GetParticipant

Read a participant's detail (state, join time, attributes, publish state,
recording state, connection metadata) for a session of the bound stage.

### Inspecting Participants
**Example:** Look up a participant
```typescript
// init
const getParticipant = yield* IVSRealtime.GetParticipant(stage);

// runtime
const { participant } = yield* getParticipant({
  sessionId: "st-a1b2c3d4e5f6",
  participantId: "abcDEF123",
});
```

@binding

## GetParticipant.Request

The `stageArn` is injected by the binding from the bound stage.

## GetStageSession

Read a session of the bound stage — its start time and, once the last
participant leaves, its end time.

### Inspecting Stage Sessions
**Example:** Look up a session
```typescript
// init
const getStageSession = yield* IVSRealtime.GetStageSession(stage);

// runtime
const { stageSession } = yield* getStageSession({
  sessionId: "st-a1b2c3d4e5f6",
});
```

@binding

## GetStageSession.Request

The `stageArn` is injected by the binding from the bound stage.

## ListCompositions

List the account's compositions in the current region, optionally
filtered by stage or encoder configuration.

### Compositing a Stage
**Example:** List running compositions
```typescript
// init
const listCompositions = yield* IVSRealtime.ListCompositions();

// runtime
const { compositions } = yield* listCompositions();
```

@binding

## ListParticipantEvents

List the events (joined, left, publish started/stopped, errors) recorded
for a participant during a session of the bound stage.

### Inspecting Participants
**Example:** Audit a participant's session events
```typescript
// init
const listParticipantEvents = yield* IVSRealtime.ListParticipantEvents(stage);

// runtime
const { events } = yield* listParticipantEvents({
  sessionId: "st-a1b2c3d4e5f6",
  participantId: "abcDEF123",
});
```

@binding

## ListParticipantEvents.Request

The `stageArn` is injected by the binding from the bound stage.

## ListParticipantReplicas

List the replicas of a participant of the bound (source) stage — the
destination stages a participant's media is replicated to and each
replica's state.

### Replicating Participants
**Example:** List a participant's replicas
```typescript
// init
const listParticipantReplicas = yield* IVSRealtime.ListParticipantReplicas(stage);

// runtime
const { replicas } = yield* listParticipantReplicas({
  participantId: "abcDEF123",
});
```

@binding

## ListParticipantReplicas.Request

The `sourceStageArn` is injected by the binding from the bound (source)
stage.

## ListParticipants

List all participants in a session of the bound stage, optionally
filtered by user id, publish state, connection state, or recording state.

### Inspecting Participants
**Example:** List a session's participants
```typescript
// init
const listParticipants = yield* IVSRealtime.ListParticipants(stage);

// runtime
const { participants } = yield* listParticipants({
  sessionId: "st-a1b2c3d4e5f6",
  filterByPublished: true,
});
```

@binding

## ListParticipants.Request

The `stageArn` is injected by the binding from the bound stage.

## ListStageSessions

List all sessions (current and past) of the bound stage, most recent
first.

### Inspecting Stage Sessions
**Example:** List a stage's sessions
```typescript
// init
const listStageSessions = yield* IVSRealtime.ListStageSessions(stage);

// runtime
const { stageSessions } = yield* listStageSessions();
```

@binding

## ListStageSessions.Request

The `stageArn` is injected by the binding from the bound stage.

## StartComposition

Start a server-side composition of the bound stage — IVS mixes the
stage's participants into a single video according to the `layout` and
delivers it to the given `destinations` (an IVS low-latency channel
and/or an S3 storage configuration).

### Compositing a Stage
**Example:** Composite a stage into an IVS channel
```typescript
// init
const startComposition = yield* IVSRealtime.StartComposition(stage);

// runtime
const { composition } = yield* startComposition({
  destinations: [{ channel: { channelArn } }],
  layout: { grid: { videoAspectRatio: "VIDEO" } },
});
```

@binding

## StartComposition.Request

The `stageArn` is injected by the binding from the bound stage.

## StopComposition

Stop and delete a composition — any broadcast to the composition's
destinations ends. Compositions are addressed by the server-generated
ARN returned by `StartComposition`.

### Compositing a Stage
**Example:** Stop a running composition
```typescript
// init
const stopComposition = yield* IVSRealtime.StopComposition();

// runtime
yield* stopComposition({ arn: compositionArn });
```

@binding
