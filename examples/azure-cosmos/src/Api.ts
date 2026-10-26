import * as Azure from "@alchemy.run/azure";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Changes, Todos, toTodo, type Change, type Todo } from "./resources.ts";

const json = (body: unknown, status = 200) => HttpServerResponse.json(body, { status });
const notFound = () => json({ error: "not found" }, 404);

/**
 * The todo API. Every route is scoped to one owner, the `Todos` partition key.
 *
 * - `POST /todos/:owner` — create `{ title }`, `201 { todo, etag }`.
 * - `GET /todos/:owner` — the owner's todos, `200 { todos }`.
 * - `GET /todos/:owner/:id` — one todo, `200 { todo, etag }`.
 * - `PATCH /todos/:owner/:id` — set `{ title?, done? }`. With an `If-Match`
 *   etag the write only applies to that version, else `412`.
 * - `DELETE /todos/:owner/:id` — `204`.
 * - `GET /changes/:owner/:id` — what the worker recorded from the change
 *   feed, `202 { status: "pending" }` until it has seen the todo.
 *
 * Any other Cosmos DB error answers `503` with the error, so a caller can
 * retry while the app's data roles propagate after a deploy.
 */
export default class Api extends Azure.Functions.Function<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const todosContainer = yield* Todos;
    const changesContainer = yield* Changes;
    // init: each binding assigns a Cosmos DB data role on its container only
    const todos = yield* Azure.CosmosDB.SqlContainerReadWrite(todosContainer);
    const changes = yield* Azure.CosmosDB.SqlContainerRead(changesContainer);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://api");
        const [collection, owner, id, ...rest] = url.pathname.split("/").filter(Boolean);

        if (collection === undefined) return HttpServerResponse.text("ok");
        if (owner === undefined || rest.length > 0) return yield* notFound();
        const partitionKey = [owner];

        if (collection === "todos" && id === undefined && request.method === "POST") {
          const body = (yield* request.json.pipe(Effect.orElseSucceed(() => ({})))) as {
            title?: unknown;
          };
          if (typeof body.title !== "string" || body.title === "") {
            return yield* json({ error: "expected { title: string }" }, 400);
          }
          const todoId = yield* Effect.sync(() => crypto.randomUUID());
          const todo: Todo = { id: todoId, owner, title: body.title, done: false };
          const created = yield* todos.create({ document: todo, partitionKey });
          return yield* json({ todo: toTodo(created.document), etag: created.etag }, 201);
        }

        if (collection === "todos" && id === undefined && request.method === "GET") {
          // One page; pass `continuation` from the response for the next one.
          const page = yield* todos.query({
            query: "SELECT * FROM c WHERE c.owner = @owner ORDER BY c._ts",
            parameters: [{ name: "@owner", value: owner }],
            partitionKey,
          });
          return yield* json({ todos: (page.Documents ?? []).map(toTodo) });
        }

        if (collection === "todos" && id !== undefined && request.method === "GET") {
          return yield* todos.get({ documentId: id, partitionKey }).pipe(
            Effect.flatMap(({ document, etag }) => json({ todo: toTodo(document), etag })),
            Effect.catchTag("CosmosNotFound", notFound),
          );
        }

        if (collection === "todos" && id !== undefined && request.method === "PATCH") {
          const body = (yield* request.json.pipe(Effect.orElseSucceed(() => ({})))) as {
            title?: unknown;
            done?: unknown;
          };
          const operations = [
            ...(typeof body.title === "string"
              ? [{ op: "set", path: "/title", value: body.title }]
              : []),
            ...(typeof body.done === "boolean"
              ? [{ op: "set", path: "/done", value: body.done }]
              : []),
          ];
          if (operations.length === 0) {
            return yield* json({ error: "expected { title?: string, done?: boolean }" }, 400);
          }
          return yield* todos
            .patch({
              documentId: id,
              partitionKey,
              operations,
              ifMatch: request.headers["if-match"],
            })
            .pipe(
              Effect.flatMap(({ document, etag }) => json({ todo: toTodo(document), etag })),
              Effect.catchTag("CosmosNotFound", notFound),
              Effect.catchTag("CosmosPreconditionFailed", () =>
                json({ error: "the todo changed since that etag" }, 412),
              ),
            );
        }

        if (collection === "todos" && id !== undefined && request.method === "DELETE") {
          return yield* todos
            .delete({ documentId: id, partitionKey })
            .pipe(
              Effect.as(HttpServerResponse.empty({ status: 204 })),
              Effect.catchTag("CosmosNotFound", notFound),
            );
        }

        if (collection === "changes" && id !== undefined && request.method === "GET") {
          return yield* changes.get({ documentId: id, partitionKey }).pipe(
            Effect.flatMap(({ document }) => {
              const { version, changedAt } = document as Change;
              return json({ change: { ...toTodo(document), version, changedAt } });
            }),
            Effect.catchTag("CosmosNotFound", () => json({ id, status: "pending" }, 202)),
          );
        }

        return yield* notFound();
      }).pipe(Effect.catchCause((cause) => json({ error: Cause.pretty(cause) }, 503))),
    };
  }).pipe(
    Effect.provide([Azure.CosmosDB.SqlContainerReadWriteHttp, Azure.CosmosDB.SqlContainerReadHttp]),
  ),
) {}
