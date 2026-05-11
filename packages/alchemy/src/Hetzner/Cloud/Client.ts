import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { HttpMethod } from "effect/unstable/http/HttpMethod";
import { HetznerCredentials } from "./Credentials.ts";

export class HetznerApiError extends Data.TaggedError("HetznerApiError")<{
  status: number;
  method: string;
  url: string;
  message: string;
  code?: string;
  body?: unknown;
}> {}

const retrySchedule = Schedule.both(
  Schedule.exponential(Duration.millis(500), 2),
  Schedule.recurs(5),
);

const doRequest = <A>(
  method: HttpMethod,
  path: string,
  body?: unknown,
): Effect.Effect<A, HetznerApiError, HetznerCredentials | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const creds = yield* HetznerCredentials;
    const client = yield* HttpClient.HttpClient;
    const url = `${creds.apiBaseUrl}${path}`;

    let req = HttpClientRequest.make(method)(url).pipe(
      HttpClientRequest.setHeader(
        "Authorization",
        `Bearer ${Redacted.value(creds.token)}`,
      ),
      HttpClientRequest.setHeader("Accept", "application/json"),
    );
    if (body !== undefined) {
      req = yield* HttpClientRequest.bodyJson(body)(req).pipe(
        Effect.mapError(
          (e) =>
            new HetznerApiError({
              status: 0,
              method,
              url,
              message: `Failed to serialize body: ${String(e)}`,
            }),
        ),
      );
    }
    const response = yield* client.execute(req).pipe(
      Effect.scoped,
      Effect.mapError(
        (e) =>
          new HetznerApiError({
            status: 0,
            method,
            url,
            message: `Network error: ${String(e)}`,
          }),
      ),
    );
    if (response.status === 204) {
      return undefined as A;
    }
    const text = yield* response.text.pipe(
      Effect.mapError(
        (e) =>
          new HetznerApiError({
            status: response.status,
            method,
            url,
            message: `Failed to read response body: ${String(e)}`,
          }),
      ),
    );
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    if (response.status >= 400) {
      const err = parsed as { error?: { message?: string; code?: string } };
      const message =
        err?.error?.message ??
        (typeof parsed === "object" &&
          parsed != null &&
          (parsed as { message?: string }).message) ||
        `HTTP ${response.status}`;
      const code = err?.error?.code;
      return yield* new HetznerApiError({
        status: response.status,
        method,
        url,
        message: typeof message === "string" ? message : `HTTP ${response.status}`,
        code,
        body: parsed,
      });
    }
    return parsed as A;
  });

/**
 * Issue a typed HTTP request to the Hetzner Cloud API. Automatically
 * retries on 429 (rate limit) and 5xx (server error) responses using
 * exponential backoff (up to 5 retries, starting at 500ms).
 */
export const request = <A>(
  method: HttpMethod,
  path: string,
  body?: unknown,
): Effect.Effect<A, HetznerApiError, HetznerCredentials | HttpClient.HttpClient> =>
  doRequest<A>(method, path, body).pipe(
    Effect.retry({
      while: (e: HetznerApiError) => e.status === 429 || e.status >= 500,
      schedule: retrySchedule,
    }),
  );

export const get = <A>(
  path: string,
): Effect.Effect<A, HetznerApiError, HetznerCredentials | HttpClient.HttpClient> =>
  request("GET", path);

export const post = <A>(
  path: string,
  body: unknown,
): Effect.Effect<A, HetznerApiError, HetznerCredentials | HttpClient.HttpClient> =>
  request("POST", path, body);

export const put = <A>(
  path: string,
  body: unknown,
): Effect.Effect<A, HetznerApiError, HetznerCredentials | HttpClient.HttpClient> =>
  request("PUT", path, body);

export const patch = <A>(
  path: string,
  body: unknown,
): Effect.Effect<A, HetznerApiError, HetznerCredentials | HttpClient.HttpClient> =>
  request("PATCH", path, body);

export const del = <A>(
  path: string,
): Effect.Effect<A, HetznerApiError, HetznerCredentials | HttpClient.HttpClient> =>
  request("DELETE", path);
