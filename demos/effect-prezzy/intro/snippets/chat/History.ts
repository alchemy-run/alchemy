import type * as Alchemy from "alchemy";
import { Queues } from "alchemy/Cloudflare";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Database } from "./Db.ts";
import { Messages, type Message } from "./Messages.ts";

// #region show
export class History extends Context.Service<
  History,
  { list(room: string): Effect.Effect<readonly string[], never, Alchemy.RuntimeContext> }
>()("History") {}

export const HistoryLive = Layer.effect(
  History,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const messages = yield* Messages;

    yield* Queues.consumeQueueMessages<Message>(messages, (batch) =>
      Stream.runForEach(batch, ({ body }) => sql`INSERT INTO messages ${sql.insert(body)}`),
    );

    return {
      list: (room: string) =>
        sql<{ text: string }>`SELECT text FROM messages WHERE room = ${room}`/*hide*/.pipe(Effect.map((rows) => rows.map((row) => row.text)), Effect.orDie)/*end*/,
    };
  }),
).pipe(Layer.provide(Database))/*hide*/.pipe(Layer.provide(Queues.EventSourceLive))/*end*/;
// #endregion show
