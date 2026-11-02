import * as Stackit from "@alchemy.run/stackit";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Quotes } from "./Quotes.ts";
import { Puller, registryFor } from "./registry.ts";

/**
 * The front door. `GET /quote` forwards to {@link Quotes}.
 *
 * `Stackit.Functions.Invoke` puts the other function's URL in this one's env when it
 * deploys, and calls it at runtime. It grants nothing, creates no service account, and
 * sends only the headers you pass.
 */
export default class Gateway extends Stackit.Functions.Function<Gateway>()(
  "Gateway",
  Effect.gen(function* () {
    const puller = yield* Puller;
    const registry = yield* registryFor("gateway");
    return {
      main: import.meta.url,
      registry,
      pullCredential: puller.pullCredentialId,
    };
  }),
  Effect.gen(function* () {
    const quotes = yield* Stackit.Functions.Invoke(yield* Quotes);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://function");

        if (request.method === "GET" && url.pathname === "/") {
          return HttpServerResponse.text("ok");
        }

        if (request.method === "GET" && url.pathname === "/quote") {
          const response = yield* quotes({ path: `/quote${url.search}` });
          return HttpServerResponse.text(yield* response.text, {
            status: response.status,
            contentType: "application/json",
          });
        }

        return HttpServerResponse.text("not found", { status: 404 });
      }).pipe(
        // Treat an unreachable backend as a 502, not a crash.
        Effect.catchTag("HttpClientError", (error) =>
          HttpServerResponse.json({ error: error.message }, { status: 502 }),
        ),
        Effect.orDie,
      ),
    };
  }).pipe(Effect.provide(Stackit.Functions.InvokeHttp)),
) {}
