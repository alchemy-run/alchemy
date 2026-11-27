import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { IssueSession } from "./IssueSession.aggregate.ts";
import { ActivityRecorded } from "./RecordActivity.command.ts";
import { ItemStored, Transcript } from "./Transcript.stream.ts";

/** Appends each recorded item to the transcript. */
export class Transcripts extends Domain.Projection("Transcripts", {
  from: [IssueSession],
  key: IssueSession,
  on: [ActivityRecorded],
  writes: [Transcript],
}) {}

export const TranscriptsLive = Transcripts.toLayer(
  Effect.gen(function* () {
    const transcript = yield* Transcript;
    return Effect.fn(function* (batch) {
      for (const input of batch) {
        yield* transcript.append(input, ...input.event.items.map((entry) => new ItemStored(entry)));
      }
    });
  }),
);
