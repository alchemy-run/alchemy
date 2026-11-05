import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Cookies from "effect/http/Cookies";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";

/** Typed failure for the fixture-driving HTTP helpers. */
export class AuthHttpError extends Data.TaggedError("AuthHttpError")<{
  readonly url: string;
  readonly status: number;
  readonly body: string;
}> {
  override get message(): string {
    return `${this.url} -> ${this.status}: ${this.body.slice(0, 300)}`;
  }
}

export interface AuthHttpResponse {
  readonly status: number;
  readonly body: string;
  readonly setCookies: ReadonlyArray<string>;
}

const request = (
  req: HttpClientRequest.HttpClientRequest,
): Effect.Effect<AuthHttpResponse, AuthHttpError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(req);
    return {
      status: response.status,
      body: yield* response.text,
      setCookies: Cookies.toSetCookieHeaders(response.cookies),
    };
  }).pipe(
    Effect.mapError((cause) => new AuthHttpError({ url: req.url, status: 0, body: String(cause) })),
  );

export const postJson = (
  url: string,
  body: unknown,
  headers?: Record<string, string>,
): Effect.Effect<AuthHttpResponse, AuthHttpError, HttpClient.HttpClient> =>
  request(
    HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders({ "content-type": "application/json", ...headers }),
      HttpClientRequest.bodyText(JSON.stringify(body), "application/json"),
    ),
  );

export const getJson = <T>(
  url: string,
  headers?: Record<string, string>,
): Effect.Effect<T, AuthHttpError, HttpClient.HttpClient> =>
  request(HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers ?? {}))).pipe(
    Effect.filterOrFail(
      (response) => response.status === 200,
      (response) => new AuthHttpError({ url, ...response }),
    ),
    Effect.map((response) => JSON.parse(response.body) as T),
  );

/**
 * Retry for the first requests against a freshly-deployed workers.dev URL
 * — the subdomain takes a few seconds to start serving.
 */
export const edgeRetry = Effect.retry({
  schedule: Schedule.exponential("1 second", 1.5),
  times: 8,
});

/** Reduce set-cookie headers to a `cookie` request header value. */
export const toCookieHeader = (setCookies: ReadonlyArray<string>): string =>
  setCookies
    .map((cookie) => cookie.split(";")[0])
    .filter((pair): pair is string => pair !== undefined && pair !== "")
    .join("; ");
