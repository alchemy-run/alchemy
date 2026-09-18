import { Function } from "@/Neon/Function";
import { waitUntil } from "@/Neon/waitUntil";
import { upgrade } from "@/Neon/upgrade";
import { Project } from "@/Neon/Project";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Redacted from "effect/Redacted";
import { Postgres } from "@/SQL/Postgres";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export default class RuntimeFunction extends Function<RuntimeFunction>()(
  "RuntimeFunction",
  Effect.gen(function* () {
    const project = yield* Project("RuntimeProject", {
      region: "aws-us-east-2",
    });
    return {
      project,
      main: import.meta.url,
      env: { FUNCTION_MESSAGE: "effect" },
    };
  }),
  Effect.gen(function* () {
    const message = yield* Config.String("FUNCTION_MESSAGE").pipe(
      Config.withDefault("effect"),
    );
    const sql = yield* Postgres({
      url: Effect.sync(() => Redacted.make(process.env.DATABASE_URL!)),
      maxConnections: 1,
    });
    let active = 0;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "https://function.test");
        yield* sql`CREATE TABLE IF NOT EXISTS alchemy_function_finalizers (id text PRIMARY KEY)`.pipe(
          Effect.orDie,
        );
        if (url.pathname === "/finalized") {
          const rows = yield* sql<{
            id: string;
          }>`SELECT id FROM alchemy_function_finalizers`.pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            finalized: rows.map((row) => row.id),
            active,
          });
        }
        const id = url.searchParams.get("id") ?? "default";
        yield* Effect.sync(() => {
          active++;
        });
        yield* Effect.addFinalizer(() =>
          sql`INSERT INTO alchemy_function_finalizers (id) VALUES (${id}) ON CONFLICT DO NOTHING`.pipe(
            Effect.orDie,
            Effect.andThen(
              Effect.sync(() => {
                active--;
              }),
            ),
          ),
        );
        if (url.pathname === "/background") {
          yield* waitUntil(
            Effect.sleep("250 millis").pipe(
              Effect.andThen(
                sql`INSERT INTO alchemy_function_finalizers (id) VALUES ('background-work') ON CONFLICT DO NOTHING`,
              ),
            ),
          );
          return HttpServerResponse.text("scheduled");
        }
        if (url.pathname === "/websocket") {
          const { socket, response } = yield* upgrade();
          yield* Effect.sync(() =>
            socket.addEventListener("message", (event) =>
              socket.send(event.data),
            ),
          );
          return response;
        }
        if (url.pathname === "/stream-cancel")
          return HttpServerResponse.stream(
            Stream.range(0, 100).pipe(
              Stream.mapEffect(() =>
                Effect.sleep("100 millis").pipe(Effect.as("tick")),
              ),
              Stream.encodeText,
            ),
          );
        if (url.pathname === "/error")
          return yield* Effect.die(
            new Error("intentional effect function failure"),
          );
        if (url.pathname === "/empty")
          return HttpServerResponse.empty({ status: 204 });
        if (url.pathname === "/stream")
          return HttpServerResponse.stream(
            Stream.make("data: first\n\n", "data: second\n\n").pipe(
              Stream.encodeText,
            ),
            { headers: { "content-type": "text/event-stream" } },
          );
        if (url.pathname === "/slow") yield* Effect.sleep("200 millis");
        return HttpServerResponse.text(message);
      }),
    };
  }),
) {}
