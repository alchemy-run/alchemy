import * as Cloudflare from "alchemy/Cloudflare";
import { Queues, R2 } from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Database } from "./Db.ts";
import { Messages, type Message } from "./Messages.ts";
import Room from "./Room.ts";

// #region show
export default Cloudflare.Worker(
  "Chat",
  { main: import.meta.url },
  Effect.gen(function* () {
    // #region rooms
    const rooms = yield* Room;
    // #endregion rooms
    // #region files
    const bucket = yield* R2.Bucket("Files");
    const files = yield* R2.ReadWriteBucket(bucket);
    // #endregion files
    // #region sql
    const sql = yield* SqlClient.SqlClient;
    // #endregion sql
    // #region consume
    const messages = yield* Messages;

    yield* Queues.consumeQueueMessages<Message>(messages, (batch) =>
      Stream.runForEach(batch, ({ body }) =>
        sql`INSERT INTO messages ${sql.insert(body)}`,
      ),
    );
    // #endregion consume
    // #region fetch

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const [, route, name] = request.url.split("/");
        // #region route
        if (route === "rooms") {
          return yield* rooms.getByName(name!).fetch(request);
        }
        // #endregion route
        // #region upload
        if (route === "files") {
          yield* files.put(name!, yield* request.text);
          return HttpServerResponse.empty({ status: 201 });
        }
        // #endregion upload
        // #region history
        if (route === "history") {
          const rows = yield* sql`
            SELECT text FROM messages WHERE room = ${name!}`;
          return yield* HttpServerResponse.json(rows);
        }
        // #endregion history
        return HttpServerResponse.text("hello");
      })/*hide*/.pipe(Effect.orDie)/*end*/,
    };
    // #endregion fetch
  })/*hide*/.pipe(Effect.provide([R2.ReadWriteBucketBinding, Queues.EventSourceLive, Database]))/*end*/,
);
// #endregion show
