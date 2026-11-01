import * as Stackit from "@alchemy.run/stackit";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Puller, registryFor } from "./registry.ts";
import { App } from "./resources.ts";

/**
 * A hit counter on a STACKIT Function, counting in Valkey over the Redis protocol.
 *
 * - `POST /hit/:key` counts one hit and returns the total.
 * - `GET /count/:key` returns the total without counting.
 *
 * `Stackit.Valkey.ReadWriteValkey` grants no role: commands authenticate with the
 * credential, whose URI reaches the function as a revision variable. Each command opens a
 * connection and closes it.
 */
export default class Api extends Stackit.Functions.Function<Api>()(
  "Api",
  Effect.gen(function* () {
    const puller = yield* Puller;
    const registry = yield* registryFor("api");
    return {
      main: import.meta.url,
      registry,
      pullCredential: puller.pullCredentialId,
    };
  }),
  Effect.gen(function* () {
    const cache = yield* Stackit.Valkey.ReadWriteValkey(yield* App);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://function");
        const [action, key] = url.pathname.split("/").filter(Boolean);

        if (request.method === "GET" && action === undefined) {
          const pong = yield* cache.ping();
          return yield* HttpServerResponse.json({ pong });
        }
        if (request.method === "POST" && action === "hit" && key !== undefined) {
          const count = yield* cache.incr(`hits:${key}`);
          return yield* HttpServerResponse.json({ key, count });
        }
        if (request.method === "GET" && action === "count" && key !== undefined) {
          const count = Number((yield* cache.get(`hits:${key}`)) ?? 0);
          return yield* HttpServerResponse.json({ key, count });
        }
        return HttpServerResponse.text("not found", { status: 404 });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Stackit.Valkey.ReadWriteValkeyHttp)),
) {}
