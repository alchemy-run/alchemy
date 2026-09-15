import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { Credentials } from "./Credentials.ts";

/** The resource does not exist. */
export class SentryNotFound extends Data.TaggedError("SentryNotFound")<{
  readonly path: string;
}> {}

/** A resource with the same slug already exists. */
export class SentryConflict extends Data.TaggedError("SentryConflict")<{
  readonly path: string;
  readonly message: string;
}> {}

/** Sentry rejected the request. */
export class SentryApiError extends Data.TaggedError("SentryApiError")<{
  readonly path: string;
  readonly status: number;
  readonly message: string;
}> {}

/** The request never reached Sentry. */
export class SentryTransportError extends Data.TaggedError(
  "SentryTransportError",
)<{
  readonly path: string;
  readonly cause: unknown;
}> {}

export type SentryError =
  | SentryNotFound
  | SentryConflict
  | SentryApiError
  | SentryTransportError;

const describe = (payload: unknown): string => {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object") {
    const detail = (payload as Record<string, unknown>).detail;
    if (typeof detail === "string") return detail;
    const slug = (payload as Record<string, unknown>).slug;
    if (Array.isArray(slug) && typeof slug[0] === "string") return slug[0];
    return JSON.stringify(payload);
  }
  return "";
};

const isConflict = (status: number, message: string) =>
  status === 409 ||
  (status === 400 && /already exists|is not available/i.test(message));

/**
 * Issue a request against Sentry's `/api/0` surface and decode the JSON body.
 *
 * The base URL comes from `Credentials`, so the same providers drive Sentry
 * SaaS and a self-hosted instance.
 */
export const request = Effect.fn("Sentry.request")(function* (
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
) {
  const { authToken, apiBaseUrl } = yield* yield* Credentials;
  const url = `${apiBaseUrl}${path}`;

  const options = {
    headers: {
      authorization: `Bearer ${Redacted.value(authToken)}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined
      ? {}
      : { body: HttpBody.text(JSON.stringify(body), "application/json") }),
  };

  const response = yield* (
    method === "GET"
      ? HttpClient.get(url, options)
      : method === "POST"
        ? HttpClient.post(url, options)
        : method === "PUT"
          ? HttpClient.put(url, options)
          : HttpClient.del(url, options)
  ).pipe(Effect.mapError((cause) => new SentryTransportError({ path, cause })));

  if (response.status === 204 || response.status === 202) {
    return undefined;
  }

  const payload: unknown = yield* response.json.pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  );

  if (response.status >= 200 && response.status < 300) {
    return payload;
  }
  if (response.status === 404) {
    return yield* new SentryNotFound({ path });
  }
  const message = describe(payload);
  if (isConflict(response.status, message)) {
    return yield* new SentryConflict({ path, message });
  }
  return yield* new SentryApiError({ path, status: response.status, message });
});
