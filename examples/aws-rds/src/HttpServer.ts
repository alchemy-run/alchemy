import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Database } from "./Database.ts";

export const HttpServer = Effect.gen(function* () {
  const db = yield* Database;

  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;

    if (request.method === "GET" && new URL(request.url).pathname === "/") {
      const response = yield* db
        .query<{
          database: string;
          current_time: string;
          current_user: string;
        }>(
          "select current_database() as database, now()::text as current_time, current_user::text as current_user",
        )
        .pipe(
          Effect.match({
            onFailure: (error) => ({
              status: 500 as const,
              body: {
                ok: false,
                error: error.message,
              },
            }),
            onSuccess: (rows) => ({
              status: 200 as const,
              body: {
                ok: true,
                connection: rows[0] ?? null,
              },
            }),
          }),
        );

      return yield* HttpServerResponse.json(response.body, {
        status: response.status,
      });
    }

    return HttpServerResponse.text("Not found", { status: 404 });
  });
});
