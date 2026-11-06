import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

/** The Rivet Cloud API. */
export const CLOUD_API_URL = "https://cloud-api.rivet.dev";

/** A Rivet Cloud API request failed or returned something unexpected. */
export class RivetCloudApiError extends Data.TaggedError("RivetCloud.ApiError")<{
  readonly message: string;
  readonly status?: number;
  /** The OAuth error code, for device sign-in polls. */
  readonly error?: string | undefined;
  readonly cause?: unknown;
}> {}

/** A Rivet Cloud cluster, as the Cloud API reports it. */
export const ClusterInfo = Schema.Struct({
  cluster: Schema.String,
  slug: Schema.String,
  domain: Schema.String,
  admin_token: Schema.NullOr(Schema.String),
  status: Schema.Struct({ state: Schema.String }),
});
export type ClusterInfo = typeof ClusterInfo.Type;

const ClusterList = Schema.Struct({ items: Schema.Array(ClusterInfo) });

/** The Rivet Cloud API's error body. */
const ErrorBody = Schema.Struct({
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
});

const send = Effect.fn("RivetCloud.send")(function* <A>(
  method: "GET" | "POST",
  path: string,
  schema: Schema.ConstraintDecoder<A, never>,
  options: { readonly token?: Redacted.Redacted<string>; readonly body?: unknown } = {},
) {
  const client = yield* HttpClient.HttpClient;
  let request = HttpClientRequest.make(method)(`${CLOUD_API_URL}${path}`).pipe(
    HttpClientRequest.acceptJson,
  );
  if (options.token !== undefined) {
    request = HttpClientRequest.bearerToken(request, Redacted.value(options.token));
  }
  if (options.body !== undefined) {
    request = HttpClientRequest.bodyJsonUnsafe(request, options.body);
  }
  const response = yield* client
    .execute(request)
    .pipe(
      Effect.mapError(
        (cause) =>
          new RivetCloudApiError({ message: `${method} ${path} failed: ${cause.message}`, cause }),
      ),
    );
  if (response.status < 200 || response.status >= 300) {
    const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    const body = yield* Schema.decodeEffect(Schema.fromJsonString(ErrorBody))(text).pipe(
      Effect.orElseSucceed(() => ({ error: undefined, error_description: undefined })),
    );
    return yield* new RivetCloudApiError({
      message: `${method} ${path} returned HTTP ${response.status}: ${text.slice(0, 300)}`,
      status: response.status,
      error: body.error,
    });
  }
  return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
    Effect.mapError(
      (cause) =>
        new RivetCloudApiError({
          message: `${method} ${path} returned an unexpected body`,
          cause,
        }),
    ),
  );
});

const get = <A>(
  token: Redacted.Redacted<string>,
  path: string,
  schema: Schema.ConstraintDecoder<A, never>,
) => send("GET", path, schema, { token });

/** Every cluster the credential can see. */
export const listClusters = (token: Redacted.Redacted<string>) =>
  get(token, "/v2/clusters", ClusterList).pipe(Effect.map((list) => list.items));

/** One cluster by its name. */
export const getCluster = (token: Redacted.Redacted<string>, cluster: string) =>
  get(token, `/v2/clusters/${encodeURIComponent(cluster)}`, ClusterInfo);

/**
 * The client id Rivet Cloud's device sign-in accepts. It is the Rivet CLI's:
 * the device endpoint rejects every other client, including ones registered
 * through dynamic client registration, and the tokens Rivet's OAuth
 * endpoints issue are for its MCP server, which the Cloud API refuses.
 */
const DEVICE_CLIENT_ID = "rivet-cli";
const DEVICE_SCOPE = "rivet:cloud:read rivet:cloud:write";

const DeviceCode = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  verification_uri_complete: Schema.optional(Schema.String),
  expires_in: Schema.Number,
  interval: Schema.Number,
});
export type DeviceCode = typeof DeviceCode.Type;

const DeviceSession = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  /** Seconds until {@link access_token} expires. */
  expires_in: Schema.Number,
});
export type DeviceSession = typeof DeviceSession.Type;

/** Start a device sign-in: the user approves {@link DeviceCode.user_code} in the dashboard. */
export const startDeviceSignIn = send("POST", "/api/auth/device/code", DeviceCode, {
  body: { client_id: DEVICE_CLIENT_ID, scope: DEVICE_SCOPE },
});

/** Poll until the user approves the device sign-in; returns a short-lived session token. */
export const awaitDeviceSignIn = (device: DeviceCode) =>
  send("POST", "/api/auth/device/token", DeviceSession, {
    body: {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: device.device_code,
      client_id: DEVICE_CLIENT_ID,
    },
  }).pipe(
    Effect.retry({
      schedule: Schedule.spaced(Duration.seconds(Math.max(device.interval, 1))),
      while: (e) => e.error === "authorization_pending" || e.error === "slow_down",
    }),
    Effect.timeoutOrElse({
      duration: Duration.seconds(Math.min(device.expires_in, 600)),
      orElse: () =>
        Effect.fail(new RivetCloudApiError({ message: "The Rivet Cloud sign-in code expired." })),
    }),
  );

/** Exchange a session's refresh token for a fresh session. */
export const refreshDeviceSession = (refreshToken: Redacted.Redacted<string>) =>
  send("POST", "/api/auth/device/refresh", DeviceSession, {
    body: { refresh_token: Redacted.value(refreshToken) },
  });

/** End a device sign-in session, best effort. */
export const endDeviceSession = (refreshToken: Redacted.Redacted<string>) =>
  send("POST", "/api/auth/device/logout", Schema.Unknown, {
    body: { refresh_token: Redacted.value(refreshToken) },
  }).pipe(Effect.ignore);
