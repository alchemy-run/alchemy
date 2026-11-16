import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type { HttpClientResponse } from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

export class ComputeInvalidProps extends Data.TaggedError("ComputeInvalidProps")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ComputeOperationFailed extends Data.TaggedError("ComputeOperationFailed")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ComputeUnexpectedResponse extends Data.TaggedError("ComputeUnexpectedResponse")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The Compute stable endpoint never became reachable before the wait timed out. */
export class ComputeUrlTimeout extends Data.TaggedError("ComputeUrlTimeout")<{
  readonly message: string;
}> {}

export interface ComputeHealthCheck {
  /**
   * Absolute application path to probe after the deployment starts and after
   * promotion.
   *
   * @example "/api/health"
   */
  path: string;
  /**
   * Exact HTTP status codes that indicate readiness. When omitted, any 2xx
   * response is healthy.
   *
   * @default Any status from 200 through 299
   */
  statusCodes?: readonly number[];
}
/** How {@link waitForComputeUrl} checks a public Compute URL. */
export interface ComputeUrlCheck {
  /**
   * Verify that the URL has reached Prisma's edge.
   *
   * @default true
   */
  readonly verifyUrl?: boolean;
  /** Application path and statuses that must answer before the URL counts as ready. */
  readonly healthCheck?: ComputeHealthCheck;
  /**
   * Maximum time to wait for the URL.
   *
   * @default 60
   */
  readonly urlReadinessTimeoutSeconds?: number;
  /**
   * Poll interval between probes.
   *
   * @default 1000
   */
  readonly pollIntervalMs?: number;
}

export const validateComputeHealthCheck = (healthCheck: ComputeHealthCheck | undefined) =>
  Effect.gen(function* () {
    if (healthCheck === undefined) return;
    if (
      !healthCheck.path.startsWith("/") ||
      healthCheck.path.startsWith("//") ||
      healthCheck.path.includes("\\") ||
      /\s/.test(healthCheck.path)
    ) {
      return yield* new ComputeInvalidProps({
        message: "healthCheck.path must be an absolute application path beginning with one '/'.",
      });
    }
    if (healthCheck.statusCodes !== undefined && healthCheck.statusCodes.length === 0) {
      return yield* new ComputeInvalidProps({
        message: "healthCheck.statusCodes must contain at least one status.",
      });
    }
    for (const status of healthCheck.statusCodes ?? []) {
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        return yield* new ComputeInvalidProps({
          message:
            "healthCheck.statusCodes must contain HTTP status integers from 100 through 599.",
        });
      }
    }
  });
const isPrismaEdgeServiceNotFound = (status: number, body: string) =>
  status === 404 &&
  (body.includes("There is no service on this URL") ||
    body.includes("<title>Service not found</title>"));

const URL_READINESS_BODY_PREFIX_BYTES = 64 * 1024;

const readResponseBodyPrefix = (response: HttpClientResponse) =>
  Effect.gen(function* () {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    yield* Stream.runForEachWhile(response.stream, (chunk) =>
      Effect.sync(() => {
        const remaining = URL_READINESS_BODY_PREFIX_BYTES - bytes;
        if (remaining <= 0) return false;
        const kept = chunk.byteLength > remaining ? chunk.slice(0, remaining) : chunk;
        chunks.push(kept);
        bytes += kept.byteLength;
        return bytes < URL_READINESS_BODY_PREFIX_BYTES;
      }),
    );
    const prefix = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      prefix.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(prefix);
  });

export const waitForComputeUrl = Effect.fn(function* (
  url: string | undefined,
  props: ComputeUrlCheck,
) {
  yield* validateComputeHealthCheck(props.healthCheck);
  if (props.healthCheck !== undefined && props.verifyUrl === false) {
    return yield* new ComputeInvalidProps({
      message: "healthCheck cannot be combined with verifyUrl: false.",
    });
  }
  if (props.verifyUrl === false) return;
  if (!url) {
    return yield* new ComputeUnexpectedResponse({
      message:
        props.healthCheck === undefined
          ? "Prisma Compute did not return a public URL for readiness verification."
          : "Prisma Compute did not return a public URL for the configured healthCheck.",
    });
  }
  const httpOption = yield* Effect.serviceOption(HttpClient.HttpClient);
  if (Option.isNone(httpOption)) {
    return props.healthCheck === undefined
      ? undefined
      : yield* new ComputeOperationFailed({
          message: "Prisma Compute healthCheck requires an HTTP client service.",
        });
  }

  const http = httpOption.value;
  const probeUrl =
    props.healthCheck === undefined ? url : new URL(props.healthCheck.path, url).toString();
  const acceptsStatus = (status: number) =>
    props.healthCheck === undefined ||
    (props.healthCheck.statusCodes === undefined
      ? status >= 200 && status <= 299
      : props.healthCheck.statusCodes.includes(status));
  const timeoutSeconds = props.urlReadinessTimeoutSeconds ?? 60;
  const intervalMs = props.pollIntervalMs ?? 1_000;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return yield* new ComputeInvalidProps({
      message: "urlReadinessTimeoutSeconds must be a positive finite number.",
    });
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return yield* new ComputeInvalidProps({
      message: "pollIntervalMs must be a positive finite number.",
    });
  }
  const timeoutMs = timeoutSeconds * 1_000;
  const startedAt = yield* Clock.currentTimeMillis;
  let lastStatus: number | undefined;
  let lastBody = "";

  while (true) {
    const beforeRequest = yield* Clock.currentTimeMillis;
    const remainingBeforeRequest = timeoutMs - (beforeRequest - startedAt);
    if (remainingBeforeRequest <= 0) {
      return yield* computeUrlTimeoutError(probeUrl, lastStatus, lastBody);
    }
    const requestTimeoutMs = Math.min(5_000, remainingBeforeRequest);
    const response = yield* http.execute(HttpClientRequest.get(probeUrl)).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "manual",
      }),
      Effect.timeoutOption(Duration.millis(requestTimeoutMs)),
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    if (response) {
      lastStatus = response.status;
      // Without an application health check, any non-404 response proves that
      // edge routing is live. A configured health check must also match its
      // status contract. Do not consume non-404 bodies: application responses
      // may intentionally stream.
      if (response.status !== 404 && acceptsStatus(response.status)) {
        return;
      }
      const beforeBody = yield* Clock.currentTimeMillis;
      const remainingBeforeBody = timeoutMs - (beforeBody - startedAt);
      if (remainingBeforeBody > 0) {
        const bodyPrefix = yield* readResponseBodyPrefix(response).pipe(
          Effect.timeoutOption(Duration.millis(Math.min(2_000, remainingBeforeBody))),
          Effect.orElseSucceed(() => Option.none<string>()),
        );
        if (Option.isSome(bodyPrefix)) {
          lastBody = bodyPrefix.value;
          if (
            !isPrismaEdgeServiceNotFound(response.status, lastBody) &&
            acceptsStatus(response.status)
          ) {
            return;
          }
        }
      }
    }

    const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
    if (elapsed >= timeoutMs) {
      return yield* computeUrlTimeoutError(probeUrl, lastStatus, lastBody);
    }

    yield* Effect.sleep(Duration.millis(Math.min(intervalMs, timeoutMs - elapsed)));
  }
});

const computeUrlTimeoutError = (url: string, lastStatus: number | undefined, lastBody: string) =>
  new ComputeUrlTimeout({
    message: [
      `Timed out waiting for Prisma Compute URL '${url}' to become reachable.`,
      lastStatus ? `Last response: HTTP ${lastStatus}.` : "No HTTP response was received.",
      lastBody.includes("There is no service on this URL")
        ? "The Prisma edge returned: There is no service on this URL."
        : undefined,
    ]
      .filter((line): line is string => line !== undefined)
      .join(" "),
  });
