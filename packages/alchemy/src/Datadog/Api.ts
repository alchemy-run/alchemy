import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { Credentials } from "./Credentials.ts";
import {
  DatadogApiError,
  DatadogAuthError,
  DatadogNotFound,
  DatadogRateLimited,
  type DatadogRequestError,
  DatadogValidationError,
} from "./Errors.ts";

export interface DatadogRequest {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  /** Path under the site's API base URL, e.g. `/api/v1/monitor`. */
  readonly path: string;
  /** Human-readable description for error reporting, e.g. `monitor 123`. */
  readonly resource: string;
  /** JSON request body. */
  readonly body?: unknown;
  /** Query string parameters; `undefined` values are omitted. */
  readonly urlParams?: Record<string, string | number | boolean | undefined>;
}

export interface DatadogApiService {
  /**
   * Execute a request against the Datadog API. Fails with a typed
   * {@link DatadogRequestError}; 429s are retried internally with bounded
   * exponential backoff before {@link DatadogRateLimited} surfaces.
   */
  readonly request: <A = unknown>(
    input: DatadogRequest,
  ) => Effect.Effect<A, DatadogRequestError>;
}

/**
 * Low-level Datadog HTTP client. Signs every request with the
 * `DD-API-KEY` / `DD-APPLICATION-KEY` headers from {@link Credentials} and
 * classifies non-2xx responses into the typed errors in `Errors.ts`.
 */
export class Api extends Context.Service<Api, DatadogApiService>()(
  "Datadog::Api",
) {}

const requestFor = (method: DatadogRequest["method"], url: string) => {
  switch (method) {
    case "GET":
      return HttpClientRequest.get(url);
    case "POST":
      return HttpClientRequest.post(url);
    case "PUT":
      return HttpClientRequest.put(url);
    case "DELETE":
      return HttpClientRequest.delete(url);
  }
};

const queryString = (
  params: Record<string, string | number | boolean | undefined> | undefined,
): string => {
  if (params === undefined) return "";
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(
      ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
    );
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
};

/** Parse Datadog's `{ "errors": ["..."] }` error body, defensively. */
const parseErrors = (text: string): string[] => {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed?.errors)) {
      return parsed.errors.map((e: unknown) =>
        typeof e === "string" ? e : JSON.stringify(e),
      );
    }
  } catch {
    // not JSON — fall through to the raw text
  }
  return text.length > 0 ? [text] : [];
};

export const ApiLive: Layer.Layer<
  Api,
  never,
  Credentials | HttpClient.HttpClient
> = Layer.effect(
  Api,
  Effect.gen(function* () {
    const credentialsEffect = yield* Credentials;
    const client = yield* HttpClient.HttpClient;

    const once = <A>(
      input: DatadogRequest,
    ): Effect.Effect<A, DatadogRequestError> =>
      Effect.gen(function* () {
        const credentials = yield* credentialsEffect;
        const url = `${credentials.apiBaseUrl}${input.path}${queryString(input.urlParams)}`;
        let req = requestFor(input.method, url).pipe(
          HttpClientRequest.setHeaders({
            "DD-API-KEY": Redacted.value(credentials.apiKey),
            "DD-APPLICATION-KEY": Redacted.value(credentials.appKey),
          }),
        );
        if (input.body !== undefined) {
          req = HttpClientRequest.bodyJsonUnsafe(input.body)(req);
        }

        const res = yield* client
          .execute(req)
          .pipe(
            Effect.mapError(
              (e) => new DatadogApiError({ status: 0, errors: [String(e)] }),
            ),
          );

        if (res.status >= 200 && res.status < 300) {
          const text = yield* res.text.pipe(
            Effect.mapError(
              (e) =>
                new DatadogApiError({
                  status: res.status,
                  errors: [String(e)],
                }),
            ),
          );
          if (text.length === 0) return undefined as A;
          return yield* Effect.try({
            try: () => JSON.parse(text) as A,
            catch: () =>
              new DatadogApiError({
                status: res.status,
                errors: [
                  `Datadog returned a non-JSON body for ${input.resource}`,
                ],
              }),
          });
        }

        const text = yield* res.text.pipe(Effect.orElseSucceed(() => ""));
        const errors = parseErrors(text);
        switch (res.status) {
          case 400:
          case 422:
            return yield* new DatadogValidationError({
              status: res.status,
              errors,
            });
          case 401:
          case 403:
            return yield* new DatadogAuthError({ status: res.status, errors });
          case 404:
            return yield* new DatadogNotFound({
              resource: input.resource,
              errors,
            });
          case 429: {
            const reset = res.headers["x-ratelimit-reset"];
            return yield* new DatadogRateLimited({
              retryAfterSeconds:
                reset !== undefined ? Number.parseInt(reset, 10) : undefined,
            });
          }
          default:
            return yield* new DatadogApiError({ status: res.status, errors });
        }
      });

    const request = <A>(input: DatadogRequest) =>
      once<A>(input).pipe(
        Effect.retry({
          while: (e) => e._tag === "Datadog.RateLimited",
          schedule: Schedule.exponential("1 second"),
          times: 5,
        }),
      );

    return { request };
  }),
);
