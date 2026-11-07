<!-- Docs for the generated AWS.IVS bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## BatchStartViewerSessionRevocation

Runtime binding for `ivs:BatchStartViewerSessionRevocation`.

Starts revoking viewer sessions for up to 20 channel-ARN/viewer-ID
pairs in one call — the multi-channel form of
`StartViewerSessionRevocation` (e.g. kicking a banned viewer off every
channel they are watching). Per-pair failures are reported in the
response's `errors` array rather than failing the whole call. The
operation spans many channels, so it is account-scoped. Provide the
implementation with
`Effect.provide(AWS.IVS.BatchStartViewerSessionRevocationHttp)`.
### Revoking Viewer Sessions
**Example:** Revoke a Viewer Across Channels
```typescript
// init — bind the account-level operation
const revokeViewerSessions =
  yield* AWS.IVS.BatchStartViewerSessionRevocation();

// runtime
const { errors } = yield* revokeViewerSessions({
  viewerSessions: [
    { channelArn: channelA, viewerId: "banned-viewer" },
    { channelArn: channelB, viewerId: "banned-viewer" },
  ],
});
```

@binding

## GetStream

Runtime binding for `ivs:GetStream`.

Reads the bound {@link Channel}'s active (live) stream — state, health,
viewer count, and playback URL. Fails with the typed
`ChannelNotBroadcasting` tag when the channel is not live. The channel
ARN is injected from the binding. Provide the implementation with
`Effect.provide(AWS.IVS.GetStreamHttp)`.
### Monitoring Live Streams
**Example:** Check Whether a Channel Is Live
```typescript
// init — bind the operation to the channel
const getStream = yield* AWS.IVS.GetStream(channel);

// runtime
const live = yield* getStream().pipe(
  Effect.map(({ stream }) => ({ live: true, viewers: stream?.viewerCount })),
  Effect.catchTag("ChannelNotBroadcasting", () =>
    Effect.succeed({ live: false, viewers: 0 }),
  ),
);
```

@binding

## GetStreamSession

Runtime binding for `ivs:GetStreamSession`.

Reads the metadata of a specific stream session on the bound
{@link Channel} — ingest configuration, recording details, and the
session's truncated event log. Omit `streamId` to read the most recent
session. The channel ARN is injected from the binding. Provide the
implementation with `Effect.provide(AWS.IVS.GetStreamSessionHttp)`.
### Monitoring Live Streams
**Example:** Inspect the Latest Broadcast Session
```typescript
// init — bind the operation to the channel
const getStreamSession = yield* AWS.IVS.GetStreamSession(channel);

// runtime
const { streamSession } = yield* getStreamSession({});
yield* Effect.log(`codec: ${streamSession?.ingestConfiguration?.video?.codec}`);
```

@binding

## InsertAdBreak

Runtime binding for `ivs:InsertAdBreak`.

Triggers a server-side ad break of the requested duration in the bound
{@link Channel}'s active stream (the channel must have an ad
configuration attached). Fails with the typed `ChannelNotBroadcasting`
tag when the channel is not live. The channel ARN is injected from the
binding. Provide the implementation with
`Effect.provide(AWS.IVS.InsertAdBreakHttp)`.
### Inserting Ad Breaks
**Example:** Trigger a 30-Second Ad Break
```typescript
// init — bind the operation to the channel
const insertAdBreak = yield* AWS.IVS.InsertAdBreak(channel);

// runtime
const { adBreakId } = yield* insertAdBreak({ durationSeconds: 30 });
```

@binding

## ListStreamSessions

Runtime binding for `ivs:ListStreamSessions`.

Enumerates current and previous broadcast sessions on the bound
{@link Channel} (most recent first). The channel ARN is injected from
the binding. Provide the implementation with
`Effect.provide(AWS.IVS.ListStreamSessionsHttp)`.
### Monitoring Live Streams
**Example:** List Recent Broadcasts
```typescript
// init — bind the operation to the channel
const listStreamSessions = yield* AWS.IVS.ListStreamSessions(channel);

// runtime
const { streamSessions } = yield* listStreamSessions({ maxResults: 10 });
yield* Effect.log(`sessions: ${streamSessions.length}`);
```

@binding

## ListStreams

Runtime binding for `ivs:ListStreams`.

Enumerates the account's live streams in the current region, optionally
filtered by stream health. This is an account-level operation — no
channel is bound, and the grant is on `*`. Provide the implementation
with `Effect.provide(AWS.IVS.ListStreamsHttp)`.
### Monitoring Live Streams
**Example:** Count Live Streams
```typescript
// init — account-level, no resource to bind
const listStreams = yield* AWS.IVS.ListStreams();

// runtime
const { streams } = yield* listStreams();
yield* Effect.log(`${streams.length} live streams`);
```

@binding

## PutMetadata

Runtime binding for `ivs:PutMetadata`.

Inserts timed metadata (max 1 KB) into the bound {@link Channel}'s
active stream — the payload is embedded in the video and surfaced to
players in sync with playback. Fails with the typed
`ChannelNotBroadcasting` tag when the channel is not live. At most 5
requests per second per channel. The channel ARN is injected from the
binding. Provide the implementation with
`Effect.provide(AWS.IVS.PutMetadataHttp)`.
### Embedding Timed Metadata
**Example:** Push a Poll Question to Viewers
```typescript
// init — bind the operation to the channel
const putMetadata = yield* AWS.IVS.PutMetadata(channel);

// runtime
yield* putMetadata({
  metadata: JSON.stringify({ question: "Who wins?", options: ["A", "B"] }),
});
```

@binding

## StartViewerSessionRevocation

Runtime binding for `ivs:StartViewerSessionRevocation`.

Starts revoking the viewer session for a given viewer ID on the bound
{@link Channel} — used with private channels to eject a viewer whose
playback authorization token carries that `viewerId`. Optionally revoke
every session at or below a token version. The channel ARN is injected
from the binding. Provide the implementation with
`Effect.provide(AWS.IVS.StartViewerSessionRevocationHttp)`.
### Revoking Viewer Sessions
**Example:** Eject a Banned Viewer
```typescript
// init — bind the operation to the channel
const revokeViewerSession = yield* AWS.IVS.StartViewerSessionRevocation(channel);

// runtime
yield* revokeViewerSession({ viewerId: "user-123" });
```

@binding

## StopStream

Runtime binding for `ivs:StopStream`.

Disconnects the incoming RTMPS broadcast on the bound {@link Channel}.
Fails with the typed `ChannelNotBroadcasting` tag when the channel is
not live. Many broadcast clients auto-reconnect, so to stop a stream
permanently, first delete or rotate the channel's stream key. The
channel ARN is injected from the binding. Provide the implementation
with `Effect.provide(AWS.IVS.StopStreamHttp)`.
### Controlling Live Streams
**Example:** Kick the Current Broadcast
```typescript
// init — bind the operation to the channel
const stopStream = yield* AWS.IVS.StopStream(channel);

// runtime
yield* stopStream().pipe(
  Effect.catchTag("ChannelNotBroadcasting", () => Effect.void),
);
```

@binding
