<!-- Docs for the generated AWS.Polly bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DescribeVoices

Runtime binding for `polly:DescribeVoices` — list the voices available
for speech synthesis, optionally filtered by engine or language.

Polly voices are account-wide, so the binding takes no arguments and
grants the function `polly:DescribeVoices`. Provide the implementation
with `Effect.provide(AWS.Polly.DescribeVoicesHttp)`.

### Discovering Voices
**Example:** List US English voices
```typescript
// init
const describeVoices = yield* AWS.Polly.DescribeVoices();

// runtime
const result = yield* describeVoices({ LanguageCode: "en-US" });
const voiceIds = (result.Voices ?? []).map((voice) => voice.Id);
```

@binding

## GetSpeechSynthesisTask

Runtime binding for `polly:GetSpeechSynthesisTask` — retrieve the status
(and output S3 URI) of an asynchronous synthesis task by its TaskId.

The binding takes no arguments and grants the function
`polly:GetSpeechSynthesisTask`. Provide the implementation with
`Effect.provide(AWS.Polly.GetSpeechSynthesisTaskHttp)`.

### Asynchronous Synthesis
**Example:** Poll a synthesis task until it completes
```typescript
// init
const getSpeechSynthesisTask = yield* AWS.Polly.GetSpeechSynthesisTask();

// runtime — bounded poll until the task leaves the queue
const task = yield* getSpeechSynthesisTask({ TaskId: taskId }).pipe(
  Effect.repeat({
    schedule: Schedule.spaced("2 seconds"),
    until: (r): boolean =>
      r.SynthesisTask?.TaskStatus === "completed" ||
      r.SynthesisTask?.TaskStatus === "failed",
    times: 25,
  }),
);
```

@binding

## ListLexicons

Runtime binding for `polly:ListLexicons` — list the pronunciation
lexicons stored in the region (name plus attributes; use the names as
`LexiconNames` in synthesis requests).

The binding takes no arguments and grants the function
`polly:ListLexicons`. Provide the implementation with
`Effect.provide(AWS.Polly.ListLexiconsHttp)`.

### Managing Lexicons
**Example:** List the region's lexicons
```typescript
// init
const listLexicons = yield* AWS.Polly.ListLexicons();

// runtime
const result = yield* listLexicons();
const names = (result.Lexicons ?? []).map((lexicon) => lexicon.Name);
```

@binding

## ListSpeechSynthesisTasks

Runtime binding for `polly:ListSpeechSynthesisTasks` — list asynchronous
synthesis tasks ordered by creation date, optionally filtered by status.

The binding takes no arguments and grants the function
`polly:ListSpeechSynthesisTasks`. Provide the implementation with
`Effect.provide(AWS.Polly.ListSpeechSynthesisTasksHttp)`.

### Asynchronous Synthesis
**Example:** List recently completed tasks
```typescript
// init
const listSpeechSynthesisTasks = yield* AWS.Polly.ListSpeechSynthesisTasks();

// runtime
const result = yield* listSpeechSynthesisTasks({
  Status: "completed",
  MaxResults: 10,
});
const taskIds = (result.SynthesisTasks ?? []).map((task) => task.TaskId);
```

@binding

## StartSpeechSynthesisStream

Runtime binding for `polly:StartSpeechSynthesisStream` — bidirectional
streaming synthesis: send text incrementally as `TextEvent`s on the input
`ActionStream` and receive `AudioEvent` chunks on the output `EventStream`
as they become available.

The binding takes no arguments and grants the function
`polly:StartSpeechSynthesisStream`. Provide the implementation with
`Effect.provide(AWS.Polly.StartSpeechSynthesisStreamHttp)`.

NOTE: the distilled HTTP transport does not yet support bidirectional
(input) event-stream request bodies — a live call currently hangs waiting
for response headers (probed 2026-07; same transport gap leaves
transcribe-streaming and lex StartConversation unbound). Prefer
`SynthesizeSpeech` (request-response) until distilled core ships
event-stream request support.

### Streaming Synthesis
**Example:** Stream text in, collect audio out
```typescript
// init
const startSpeechSynthesisStream =
  yield* AWS.Polly.StartSpeechSynthesisStream();

// runtime
const result = yield* startSpeechSynthesisStream({
  Engine: "generative",
  OutputFormat: "mp3",
  VoiceId: "Matthew",
  ActionStream: Stream.make(
    { TextEvent: { Text: "Hello from Alchemy." } },
    { CloseStreamEvent: {} },
  ),
});
const events = yield* Stream.runCollect(result.EventStream!);
const audioBytes = Array.from(events)
  .flatMap((event) => (event.AudioEvent?.AudioChunk ? [event.AudioEvent.AudioChunk] : []))
  .reduce((total, chunk) => total + chunk.length, 0);
```

@binding

## StartSpeechSynthesisTask

Runtime binding for `polly:StartSpeechSynthesisTask` — start an
asynchronous synthesis task that writes the audio (or speech marks) to an
S3 bucket, for texts too long for the synchronous `SynthesizeSpeech`.

The binding grants `polly:StartSpeechSynthesisTask`. Polly writes the
output with the **caller's** credentials, so the function also needs
`s3:PutObject` on the output bucket — compose with
`AWS.S3.PutObject(bucket)`. Provide the implementation with
`Effect.provide(AWS.Polly.StartSpeechSynthesisTaskHttp)`.

### Asynchronous Synthesis
**Example:** Start a synthesis task writing MP3 to S3
```typescript
// init — the S3 PutObject binding grants Polly's output write
yield* AWS.S3.PutObject(bucket);
const startSpeechSynthesisTask = yield* AWS.Polly.StartSpeechSynthesisTask();

// runtime
const started = yield* startSpeechSynthesisTask({
  OutputFormat: "mp3",
  OutputS3BucketName: "my-audio-bucket",
  VoiceId: "Joanna",
  Text: longArticleText,
});
const taskId = started.SynthesisTask?.TaskId;
```

@binding
