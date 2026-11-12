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

/** The Rivet Cloud API found nothing at the path. */
export class RivetCloudNotFound extends Data.TaggedError("RivetCloud.NotFound")<{
  readonly message: string;
}> {}

/** The Rivet Cloud API refused a change that conflicts with the current state. */
export class RivetCloudConflict extends Data.TaggedError("RivetCloud.Conflict")<{
  readonly message: string;
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

type Method = "GET" | "POST" | "PUT" | "DELETE";

/** A bearer token and, for a sign-in session, the organization it acts in. */
export interface CloudAuth {
  readonly token: Redacted.Redacted<string>;
  readonly organization?: string | undefined;
}

/** The header naming the organization a sign-in session acts in. */
export const ORGANIZATION_HEADER = "x-rivet-organization";

interface RequestOptions {
  readonly auth?: CloudAuth;
  readonly body?: unknown;
}

/** Send a request and fail on any status outside 2xx with the API's error. */
const request = Effect.fn("RivetCloud.request")(function* (
  method: Method,
  path: string,
  options: RequestOptions = {},
) {
  const client = yield* HttpClient.HttpClient;
  let req = HttpClientRequest.make(method)(`${CLOUD_API_URL}${path}`).pipe(
    HttpClientRequest.acceptJson,
  );
  if (options.auth !== undefined) {
    req = HttpClientRequest.bearerToken(req, Redacted.value(options.auth.token));
    if (options.auth.organization !== undefined) {
      req = HttpClientRequest.setHeader(req, ORGANIZATION_HEADER, options.auth.organization);
    }
  }
  if (options.body !== undefined) {
    req = HttpClientRequest.bodyJsonUnsafe(req, options.body);
  }
  const response = yield* client
    .execute(req)
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
    const message = `${method} ${path} returned HTTP ${response.status}: ${text.slice(0, 300)}`;
    if (response.status === 404) return yield* new RivetCloudNotFound({ message });
    if (response.status === 409) return yield* new RivetCloudConflict({ message });
    return yield* new RivetCloudApiError({ message, status: response.status, error: body.error });
  }
  return response;
});

/** Send a request and decode its JSON body. */
const send = <A>(
  method: Method,
  path: string,
  schema: Schema.ConstraintDecoder<A, never>,
  options: RequestOptions = {},
) =>
  request(method, path, options).pipe(
    Effect.flatMap((response) =>
      HttpClientResponse.schemaBodyJson(schema)(response).pipe(
        Effect.mapError(
          (cause) =>
            new RivetCloudApiError({
              message: `${method} ${path} returned an unexpected body`,
              cause,
            }),
        ),
      ),
    ),
  );

/** Send a request whose response body, if any, says nothing more. */
const sendVoid = (method: Method, path: string, options: RequestOptions = {}) =>
  request(method, path, options).pipe(Effect.asVoid);

const get = <A>(auth: CloudAuth, path: string, schema: Schema.ConstraintDecoder<A, never>) =>
  send("GET", path, schema, { auth });

/** Every cluster the credential can see. */
export const listClusters = (auth: CloudAuth) =>
  get(auth, "/v2/clusters", ClusterList).pipe(Effect.map((list) => list.items));

/** An organization a sign-in session belongs to. */
export const OrganizationInfo = Schema.Struct({
  name: Schema.String,
  slug: Schema.String,
});
export type OrganizationInfo = typeof OrganizationInfo.Type;

/** The organizations a sign-in session belongs to, as the Rivet CLI lists them. */
export const listOrganizations = (auth: CloudAuth) =>
  get(
    auth,
    "/oauth/organizations",
    Schema.Struct({ organizations: Schema.Array(OrganizationInfo) }),
  ).pipe(Effect.map((list) => list.organizations));

/** One cluster by its name. */
export const getCluster = (auth: CloudAuth, cluster: string) =>
  get(auth, `/v2/clusters/${encodeURIComponent(cluster)}`, ClusterInfo);

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
      while: (e) =>
        e._tag === "RivetCloud.ApiError" &&
        (e.error === "authorization_pending" || e.error === "slow_down"),
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
  sendVoid("POST", "/api/auth/device/logout", {
    body: { refresh_token: Redacted.value(refreshToken) },
  }).pipe(Effect.ignore);

/** A region of a cluster. */
const Region = Schema.Struct({
  region: Schema.String,
  status: Schema.Struct({ state: Schema.String }),
});

/** The regions a cluster runs in. */
export const listRegions = (auth: CloudAuth, cluster: string) =>
  get(
    auth,
    `/v2/clusters/${encodeURIComponent(cluster)}/regions`,
    Schema.Struct({ items: Schema.Array(Region) }),
  ).pipe(Effect.map((list) => list.items));

/** Where a rollout or a resource stands. */
const Status = Schema.Struct({
  state: Schema.String,
  message: Schema.NullOr(Schema.String),
  fault: Schema.NullOr(Schema.String),
  action_needed: Schema.Boolean,
  replicas: Schema.NullOr(
    Schema.Struct({ desired: Schema.Number, ready: Schema.Number, updated: Schema.Number }),
  ),
});

/** A build: a Docker image uploaded for runner pools to boot. */
export const BuildInfo = Schema.Struct({
  build_id: Schema.String,
  image: Schema.String,
  status: Schema.String,
  failure: Schema.NullOr(
    Schema.Struct({ fault: Schema.String, code: Schema.String, message: Schema.String }),
  ),
});
export type BuildInfo = typeof BuildInfo.Type;

const buildsPath = (cluster: string) => `/v2/clusters/${encodeURIComponent(cluster)}/builds`;

/** Every build on the cluster. */
export const listBuilds = (auth: CloudAuth, cluster: string) =>
  get(auth, buildsPath(cluster), Schema.Struct({ items: Schema.Array(BuildInfo) })).pipe(
    Effect.map((list) => list.items),
  );

/** Register a build; its image tarball goes to `upload_url`. */
export const createBuild = (
  auth: CloudAuth,
  cluster: string,
  body: { readonly image: string; readonly content_length: number; readonly content_md5: string },
) =>
  send(
    "POST",
    buildsPath(cluster),
    Schema.Struct({ build_id: Schema.String, upload_url: Schema.String }),
    { auth, body },
  );

/** Upload a build's image tarball: one PUT, with its MD5. */
export const uploadBuild = Effect.fn("RivetCloud.uploadBuild")(function* (
  url: string,
  tarball: Uint8Array,
  md5: string,
) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(
      HttpClientRequest.put(url).pipe(
        HttpClientRequest.setHeader("Content-MD5", md5),
        HttpClientRequest.bodyUint8Array(tarball, "application/x-tar"),
      ),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new RivetCloudApiError({ message: `Build upload failed: ${cause.message}`, cause }),
      ),
    );
  if (response.status < 200 || response.status >= 300) {
    const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    return yield* new RivetCloudApiError({
      message: `Build upload returned HTTP ${response.status}: ${text.slice(0, 300)}`,
      status: response.status,
    });
  }
});

/** Ask Rivet to verify an uploaded build and prepare it. */
export const completeBuild = (auth: CloudAuth, cluster: string, build: string) =>
  sendVoid("POST", `${buildsPath(cluster)}/${encodeURIComponent(build)}/complete`, { auth });

/** One build and where it is in its lifecycle. */
export const getBuild = (auth: CloudAuth, cluster: string, build: string) =>
  get(auth, `${buildsPath(cluster)}/${encodeURIComponent(build)}`, BuildInfo);

/** Delete a build; refused while a pool runs it or can roll back to it. */
export const deleteBuild = (auth: CloudAuth, cluster: string, build: string) =>
  sendVoid("DELETE", `${buildsPath(cluster)}/${encodeURIComponent(build)}`, { auth });

/** A runner pool: nodes Rivet runs, booted from a build. */
export const RunnerPoolInfo = Schema.Struct({
  pool: Schema.String,
  region: Schema.String,
  build_id: Schema.NullOr(Schema.String),
  machine_type: Schema.NullOr(Schema.String),
  node_count: Schema.Number,
  cidr_allowlist: Schema.Array(Schema.String),
  endpoints: Schema.Struct({ public: Schema.NullOr(Schema.String) }),
  status: Status,
});
export type RunnerPoolInfo = typeof RunnerPoolInfo.Type;

const runnerPoolPath = (cluster: string, region: string, pool: string) =>
  `/v2/clusters/${encodeURIComponent(cluster)}/regions/${encodeURIComponent(region)}/runner-pools/${encodeURIComponent(pool)}`;

/** One runner pool. */
export const getRunnerPool = (auth: CloudAuth, cluster: string, region: string, pool: string) =>
  get(auth, runnerPoolPath(cluster, region, pool), RunnerPoolInfo);

/** Roll a runner pool out to a build, creating it when it does not exist. */
export const putRunnerPool = (
  auth: CloudAuth,
  cluster: string,
  region: string,
  pool: string,
  body: {
    readonly build_id: string;
    readonly cidr_allowlist: ReadonlyArray<string>;
    readonly machine_type?: string | undefined;
    readonly node_count?: number | undefined;
  },
) => send("PUT", runnerPoolPath(cluster, region, pool), RunnerPoolInfo, { auth, body });

/** Request a runner pool's removal. */
export const deleteRunnerPool = (auth: CloudAuth, cluster: string, region: string, pool: string) =>
  sendVoid("DELETE", runnerPoolPath(cluster, region, pool), { auth });
