import * as Azure from "@alchemy.run/azure";
import { Credentials } from "@distilled.cloud/azure/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Redacted from "effect/Redacted";
import { Quotes } from "./Quotes.ts";
import { QuotesApi } from "./resources.ts";

/**
 * The public front door, an Azure Function (Flex Consumption). It forwards
 * `GET /quote` to the private {@link Quotes} container app.
 *
 * Init reads two deploy-time values that Alchemy binds into the app's
 * settings: Quotes' URL and the `appId` of the {@link QuotesApi}
 * application. Per request, the Function asks its system-assigned managed
 * identity for a token with that audience and sends it as
 * `Authorization: Bearer`. The Function holds no secret.
 */
export default class Gateway extends Azure.Functions.Function<Gateway>()(
  "Gateway",
  { main: import.meta.url },
  Effect.gen(function* () {
    const quotes = yield* Quotes;
    const quotesUrl = yield* quotes.url;
    const api = yield* QuotesApi;
    const audience = yield* api.appId;
    // At runtime: the app's managed identity (the Functions host provides it).
    const credentials = yield* Credentials;
    const http = yield* HttpClient.HttpClient;

    /** A managed-identity token for the Quotes API. */
    const quotesToken = Effect.gen(function* () {
      const config = yield* credentials;
      const appId = yield* audience;
      if (config.tokenFor === undefined) return config.bearerToken;
      return yield* config.tokenFor(`${appId}/.default`);
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");

        if (request.method === "GET" && url.pathname === "/") {
          return HttpServerResponse.text("ok");
        }

        if (request.method === "GET" && url.pathname === "/quote") {
          const base = yield* quotesUrl;
          const token = yield* quotesToken;
          // A call to the stack's own deployed endpoint, so plain HTTP.
          const response = yield* http.execute(
            HttpClientRequest.get(`${base}/quote${url.search}`).pipe(
              HttpClientRequest.bearerToken(Redacted.value(token)),
            ),
          );
          const body = yield* response.text;
          // Relay Quotes' answer, including its 401 or 403.
          return HttpServerResponse.text(body, {
            status: response.status,
            contentType: response.headers["content-type"] ?? "text/plain",
          });
        }

        return HttpServerResponse.text("not found", { status: 404 });
      }).pipe(
        // Every failure is a typed tag. Answer it with a 502 so the caller
        // sees which one.
        Effect.catch((error) =>
          Effect.succeed(HttpServerResponse.text(error._tag, { status: 502 })),
        ),
      ),
    };
  }),
) {}
