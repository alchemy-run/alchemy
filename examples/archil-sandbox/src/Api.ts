import * as Archil from "@alchemy.run/archil";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Files } from "./Storage.ts";

/**
 * A program in its own Archil sandbox: `PUT /:key` writes a file to the
 * disk; `GET /:key` reads it back.
 */
export default class Api extends Archil.Sandbox<Api>()(
  "Api",
  { main: import.meta.url, port: 3000 },
  Effect.gen(function* () {
    const files = yield* Archil.ReadWriteDisk(Files);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const key = new URL(request.url, "http://api").pathname.slice(1);
        if (request.method === "PUT") {
          const body = yield* request.text;
          yield* files.put(key, body);
          return HttpServerResponse.empty({ status: 201 });
        }
        const file = yield* files.head(key);
        if (file === undefined) {
          return HttpServerResponse.text("not found", { status: 404 });
        }
        const text = yield* files.getText(key);
        return HttpServerResponse.text(text);
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(HttpServerResponse.text(String(error), { status: 500 })),
        ),
      ),
    };
  }).pipe(Effect.provide(Archil.ReadWriteDiskHttp)),
) {}
