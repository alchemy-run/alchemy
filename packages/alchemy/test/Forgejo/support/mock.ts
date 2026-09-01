import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

/**
 * One request observed by the Forgejo mock.
 */
export interface RecordedRequest {
  /**
   * HTTP method.
   */
  readonly method: string;
  /**
   * Path, excluding the `/api/v1` prefix and the query string.
   */
  readonly path: string;
  /**
   * Parsed query parameters.
   */
  readonly query: Readonly<Record<string, string>>;
  /**
   * Parsed JSON request body, or `undefined` when the request had none.
   */
  readonly body: unknown;
}

/**
 * A recording `HttpClient` backed by an in-memory route table.
 */
export interface MockForgejo {
  /**
   * Every request the client has issued, in order.
   */
  readonly requests: RecordedRequest[];
  /**
   * `HttpClient` layer to provide to the Forgejo credentials layer.
   */
  readonly layer: Layer.Layer<HttpClient.HttpClient>;
  /**
   * Discard recorded requests.
   */
  readonly reset: () => void;
  /**
   * Find the first recorded request matching a method and exact path.
   */
  readonly find: (method: string, path: string) => RecordedRequest | undefined;
  /**
   * Count recorded requests matching a method and exact path.
   */
  readonly count: (method: string, path: string) => number;
}

/**
 * Decode a request body back to JSON.
 *
 * The client builds bodies with `HttpClientRequest.bodyJsonUnsafe`, which
 * produces a `Uint8Array` body; every other tag means the request carried no
 * JSON payload.
 */
const decodeBody = (body: HttpBody.HttpBody): unknown => {
  if (body._tag !== "Uint8Array") return undefined;
  const text = new TextDecoder().decode(body.body);
  return text === "" ? undefined : (JSON.parse(text) as unknown);
};

/**
 * Build a mock Forgejo instance from a route handler.
 *
 * The handler receives each parsed request and returns the `Response` to
 * reply with. Returning `undefined` produces a `500`, so an unanticipated
 * request fails the test loudly instead of being silently treated as a
 * missing resource.
 */
export const mockForgejo = (
  handle: (request: RecordedRequest) => Response | undefined,
): MockForgejo => {
  const requests: RecordedRequest[] = [];

  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      const recorded: RecordedRequest = {
        method: request.method,
        path: url.pathname.replace(/^\/api\/v1/, ""),
        query: Object.fromEntries(url.searchParams),
        body: decodeBody(request.body),
      };
      requests.push(recorded);
      return HttpClientResponse.fromWeb(
        request,
        handle(recorded) ??
          new Response(`unhandled: ${recorded.method} ${recorded.path}`, {
            status: 500,
          }),
      );
    }),
  );

  return {
    requests,
    layer: Layer.succeed(HttpClient.HttpClient, client),
    reset: () => {
      requests.length = 0;
    },
    find: (method, path) =>
      requests.find(
        (request) => request.method === method && request.path === path,
      ),
    count: (method, path) =>
      requests.filter(
        (request) => request.method === method && request.path === path,
      ).length,
  };
};

/**
 * Build a JSON response.
 */
export const json = (body: unknown, status = 200) =>
  Response.json(body, { status });

/**
 * Build an empty `204 No Content` response.
 */
export const noContent = () => new Response(null, { status: 204 });

/**
 * Build an error response with a plain-text body.
 */
export const status = (code: number, body = "") =>
  new Response(body, { status: code });
