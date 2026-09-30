import type * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Queues } from "alchemy/Cloudflare";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Database } from "./Db.ts";
import { Files, type UploadError } from "./Files.ts";

/** A chat message: a room name and some text. */
export type Message = { room: string; text: string };

// #region show
// #region service
export class History extends Context.Service<
  History,
  {
    append(room: string, text: string): Effect.Effect<void, never, Alchemy.RuntimeContext>;
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
    // #region queue
    const messages = yield* Cloudflare.Queues.Queue("Messages");
    // #region queueBinding
    const queue = yield* Queues.WriteQueue(messages);
    // #endregion queueBinding
    // #endregion queue
    // #region consume

    yield* Queues.consumeQueueMessages<Message>(
      messages,
      Stream.runForEach(({ body }) =>
        sql`INSERT INTO messages ${sql.insert(body)}`,
      ),
    );
    // #endregion consume
    // #region methods

    return {
      // #region append
      append: (room: string, text: string) => queue.send({ room, text })/*hide*/.pipe(Effect.orDie)/*end*/,
      // #endregion append
      // #region list
      list: (room: string) =>
        sql<{ text: string }>`SELECT text FROM messages WHERE room = ${room}`/*hide*/.pipe(Effect.map((rows) => rows.map((row) => row.text)), Effect.orDie)/*end*/,
      // #endregion list
      // #region attach
      attach: (room: string, file: string, body: string) =>
        Effect.gen(function* () {
          yield* files.upload(file, body);
          yield* sql`INSERT INTO messages ${sql.insert({ room, text: file })}`/*hide*/.pipe(Effect.orDie)/*end*/;
        }),
      // #endregion attach
    };
    // #endregion methods
  }),
)/*hide*/.pipe(Layer.provide([Queues.WriteQueueBinding, Queues.EventSourceLive]))/*end*/;
// #endregion live
// #endregion show
