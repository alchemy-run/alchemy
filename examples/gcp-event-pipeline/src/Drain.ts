import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Analytics, EventsTable, Inbox, type EventRow } from "./resources.ts";

/** One pull returns at most this many messages. */
const BATCH = 100;

/**
 * The batch half of the pipeline: drain Pub/Sub into BigQuery.
 *
 * A Cloud Run Job is the right host for this. It runs to completion and
 * exits, so nothing is billed between drains, and Cloud Scheduler or an
 * operator can start it whenever a batch is due.
 *
 * The order matters: insert first, ack second. A crash between them
 * redelivers the batch and duplicates rows, which a `SELECT DISTINCT id`
 * removes; acking first would lose events outright.
 */
export default class Drain extends GCP.Run.Job<Drain>()(
  "Drain",
  {
    main: import.meta.url,
    location: "us-central1",
  },
  Effect.gen(function* () {
    const inbox = yield* Inbox;
    const dataset = yield* Analytics;
    const table = yield* EventsTable;

    const pull = yield* GCP.PubSub.Pull(inbox);
    const acknowledge = yield* GCP.PubSub.Acknowledge(inbox);
    const insertAll = yield* GCP.BigQuery.InsertAll(table);

    // Forces the job to wait for the dataset before its first run.
    yield* dataset.datasetId;

    return {
      // A pull may return fewer messages than are waiting, so drain
      // batch by batch until one comes back empty.
      run: Effect.gen(function* () {
        // A pull waits for messages; an empty subscription answers
        // nothing, so a quiet 10 seconds means the backlog is drained.
        const received = yield* pull({ body: { maxMessages: BATCH } }).pipe(
          Effect.timeoutOption("10 seconds"),
        );
        const messages =
          Option.getOrUndefined(received)?.receivedMessages ?? [];
        if (messages.length === 0) {
          yield* Effect.log("drain: nothing left");
          return 0;
        }

        const rows = messages.flatMap((message) => {
          const data = message.message?.data;
          if (data === undefined) return [];
          const row = JSON.parse(atob(data)) as EventRow;
          // insertId makes the streaming insert idempotent inside
          // BigQuery's dedup window, so a redelivered batch collapses.
          return [{ insertId: row.id, json: row }];
        });

        yield* insertAll({ body: { rows } });

        yield* acknowledge({
          body: {
            ackIds: messages.flatMap((message) =>
              message.ackId === undefined ? [] : [message.ackId],
            ),
          },
        });

        yield* Effect.log(`drain: wrote ${rows.length} row(s)`);
        return messages.length;
      }).pipe(
        Effect.repeat({ until: (count) => count === 0 }),
        Effect.asVoid,
        Effect.orDie,
      ),
    };
  }).pipe(
    Effect.provide([
      GCP.PubSub.PullHttp,
      GCP.PubSub.AcknowledgeHttp,
      GCP.BigQuery.InsertAllHttp,
    ]),
  ),
) {}
