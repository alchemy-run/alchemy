import type * as Alchemy from "alchemy";
import { Queues } from "alchemy/Cloudflare";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Database } from "./Db.ts";
import { Files, type UploadError } from "./Files.ts";
import { Messages, type Message } from "./Messages.ts";

// #region show
// #region service
export class History extends Context.Service<
  History,
  {
    list(room: string): Effect.Effect<readonly string[], never, Alchemy.RuntimeContext>;
    attach(room: string, file: string, body: string): Effect.Effect<void, UploadError, Alchemy.RuntimeContext>;
  }
>()("History") {}
// #endregion service
// #region live

export const HistoryLive = Layer.effect(
  History,
  Effect.gen(function* () {
    // #region deps
    const sql = yield* Database;
    const files = yield* Files;
    // #endregion deps
    // #region consume
    const messages = yield* Messages;

    yield* Queues.consumeQueueMessages<Message>(messages, (batch) =>
      Stream.runForEach(batch, ({ body }) => sql`INSERT INTO messages ${sql.insert(body)}`),
    );
    // #endregion consume

    return {
      list: (room: string) =>
        sql<{ text: string }>`SELECT text FROM messages WHERE room = ${room}`/*hide*/.pipe(Effect.map((rows) => rows.map((row) => row.text)), Effect.orDie)/*end*/,
      attach: (room: string, file: string, body: string) =>
        Effect.gen(function* () {
          yield* files.upload(file, body);
          yield* sql`INSERT INTO messages ${sql.insert({ room, text: file })}`/*hide*/.pipe(Effect.orDie)/*end*/;
        }),
    };
  }),
)/*hide*/.pipe(Layer.provide(Queues.EventSourceLive))/*end*/;
// #endregion live
// #endregion show
