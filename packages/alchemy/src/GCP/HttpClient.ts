import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

/**
 * Services whose regional resources (`projects/*\/locations/{location}/…`)
 * are only served from `{service}.{location}.rep.googleapis.com`; the
 * global endpoint rejects them with `INVALID_ARGUMENT`. Distilled bakes
 * the global base URL into every operation.
 */
const REGIONAL_ENDPOINT =
  /^https:\/\/(secretmanager)\.googleapis\.com\/(v1[a-z0-9]*\/projects\/[^/]+\/locations\/([a-z0-9-]+)\/.*)$/;

/** Send regional-resource requests to the service's regional endpoint. */
export const routeRegionalEndpoints = (
  client: HttpClient.HttpClient,
): HttpClient.HttpClient =>
  HttpClient.mapRequest(client, (request) => {
    const match = REGIONAL_ENDPOINT.exec(request.url);
    if (match === null || match[3] === "global") return request;
    return HttpClientRequest.setUrl(
      request,
      `https://${match[1]}.${match[3]}.rep.googleapis.com/${match[2]}`,
    );
  });

/**
 * The `HttpClient` GCP providers, bindings, and runtimes use: fetch, with
 * regional Secret Manager resources routed to their regional endpoint.
 */
export const GcpHttpClient: Layer.Layer<HttpClient.HttpClient> = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    return routeRegionalEndpoints(yield* HttpClient.HttpClient);
  }),
).pipe(Layer.provide(FetchHttpClient.layer));
