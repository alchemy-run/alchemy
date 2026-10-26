import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schedule from "effect/Schedule";
import { Changes, Leases, Todos, toTodo, type Change } from "./resources.ts";

/**
 * The change-feed consumer. `consumeChangeFeed` becomes a native
 * `cosmosDBTrigger` function in this app, connected through the app's
 * managed identity, with its checkpoints in the `Leases` container.
 *
 * Each batch holds the latest version of every todo created or updated
 * since the last batch; several updates to one todo can arrive as one
 * version, and deletes are not in the feed. The worker upserts that version
 * into `Changes`, so a redelivered batch writes the same document again.
 */
export default class Worker extends Azure.Functions.Function<Worker>()(
  "Worker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const leases = yield* Leases;
    const changesContainer = yield* Changes;
    const changes = yield* Azure.CosmosDB.SqlContainerWrite(changesContainer);

    // From the beginning: the trigger starts once the app's data role
    // applies (a few minutes after the first deploy), and todos written
    // before that would otherwise be skipped.
    yield* Azure.CosmosDB.consumeChangeFeed(
      Todos,
      { leases, startFromBeginning: true },
      (documents) =>
        Effect.forEach(documents, (document) => {
          const change: Change = {
            ...toTodo(document),
            version: String(document._etag),
            changedAt: Number(document._ts),
          };
          return changes.upsert({ document: change, partitionKey: [change.owner] }).pipe(
            // The write role can trail the first deploy. Distilled already
            // retries throttled (429) writes.
            Effect.retry({
              while: (error) => error._tag === "CosmosRbacPermissionDenied",
              schedule: Schedule.spaced("5 seconds"),
              times: 10,
            }),
          );
        }).pipe(
          // A failure dies the invocation and the Functions host logs it.
          Effect.orDie,
          Effect.asVoid,
        ),
    );

    return {
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }).pipe(
    Effect.provide([
      Azure.Functions.CosmosDBChangeFeedEventSource,
      Azure.CosmosDB.SqlContainerWriteHttp,
    ]),
  ),
) {}
