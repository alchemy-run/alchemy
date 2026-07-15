// TEMPORARY probe — characterizes distilled's bidirectional event-stream
// support for polly.startSpeechSynthesisStream outside a Lambda. Deleted
// once the verdict is captured.
import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as polly from "@distilled.cloud/aws/polly";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "probe: startSpeechSynthesisStream round-trip",
  (_stack) =>
    Effect.gen(function* () {
      const result = yield* polly
        .startSpeechSynthesisStream({
          Engine: "generative",
          OutputFormat: "mp3",
          VoiceId: "Matthew",
          ActionStream: Stream.make(
            { TextEvent: { Text: "Hello from the probe." } },
            { CloseStreamEvent: {} },
          ),
        })
        .pipe(
          Effect.tapError((e) =>
            Effect.logError(`RESPONSE FAILED: ${JSON.stringify(e)}`),
          ),
          Effect.timeout("20 seconds"),
        );
      yield* Effect.logInfo("response received; collecting event stream");
      const events = Array.from(
        yield* Stream.runCollect(result.EventStream!).pipe(
          Effect.timeout("20 seconds"),
        ),
      );
      const audioBytes = events.reduce(
        (total, event) => total + (event.AudioEvent?.AudioChunk?.length ?? 0),
        0,
      );
      yield* Effect.logInfo(
        `events=${events.length} audioBytes=${audioBytes} closed=${events.some((e) => e.StreamClosedEvent !== undefined)}`,
      );
    }),
  { timeout: 60_000 },
);
