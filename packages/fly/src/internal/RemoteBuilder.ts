import {
  DockerEnvironment,
  type Docker,
  type RegistryCredentials,
} from "@alchemy.run/docker/Docker";
import * as builders from "@distilled.cloud/fly-io/builders";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { Base64 } from "effect/encoding";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

/**
 * Build images on Fly's remote builders, the way `fly deploy` does: Fly's
 * GraphQL API starts a Depot build for the App, Depot hands back a BuildKit
 * machine next to Fly's registry, and `docker buildx` drives it through the
 * `remote` driver. Only the build context leaves this machine; the base
 * image is pulled and the result pushed from the builder.
 */

const DEPOT_API = "https://api.depot.dev/depot.cli.v1.BuildService";
/**
 * Depot builders push `registry.fly.io` images through Fly's internal registry
 * mirror, which takes the same login (`authConfigs` in flyctl's imgsrc).
 */
const FLY_REGISTRY_MIRROR = "_api.internal:5000";
const HEALTH_INTERVAL = Duration.seconds(5);
/** Builders usually go active within ~15s; give up well before the deploy would. */
const MAX_PENDING_POLLS = 240;

export class RemoteBuilderError extends Data.TaggedError("Fly.RemoteBuilderError")<{
  operation: string;
  message: string;
}> {}

const BuildKitConnection = Schema.Union([
  Schema.Struct({
    active: Schema.Struct({
      endpoint: Schema.String,
      serverName: Schema.String,
      cert: Schema.Struct({ cert: Schema.String, key: Schema.String }),
      caCert: Schema.Struct({ cert: Schema.String }),
    }),
  }),
  Schema.Struct({ pending: Schema.Struct({ waitMs: Schema.optional(Schema.Number) }) }),
]);

const depot = Effect.fn(function* <A>(
  method: string,
  token: Redacted.Redacted<string>,
  body: unknown,
  response: Schema.Codec<A, unknown>,
) {
  const client = yield* HttpClient.HttpClient;
  const fail = (message: string) => new RemoteBuilderError({ operation: method, message });
  const res = yield* client
    .execute(
      HttpClientRequest.post(`${DEPOT_API}/${method}`).pipe(
        HttpClientRequest.bearerToken(Redacted.value(token)),
        HttpClientRequest.bodyJsonUnsafe(body),
      ),
    )
    .pipe(Effect.mapError((cause) => fail(String(cause))));
  if (res.status < 200 || res.status >= 300) {
    const text = yield* res.text.pipe(Effect.orElseSucceed(() => ""));
    return yield* fail(`HTTP ${res.status}: ${text}`);
  }
  return yield* HttpClientResponse.schemaBodyJson(response)(res).pipe(
    Effect.mapError(() => fail("unexpected response body")),
  );
});

const basicAuth = ({ username, password }: RegistryCredentials) =>
  Base64.encode(
    `${username}:${Redacted.isRedacted(password) ? Redacted.value(password) : password}`,
  );

const platformOf = (platform: string) =>
  /arm|aarch/.test(platform) ? "BUILDER_PLATFORM_ARM64" : "BUILDER_PLATFORM_AMD64";

/** Poll Depot until the build's BuildKit machine is active. */
const acquireConnection = Effect.fn(function* (
  buildId: string,
  token: Redacted.Redacted<string>,
  platform: string,
) {
  for (let poll = 0; poll < MAX_PENDING_POLLS; poll++) {
    const connection = yield* depot(
      "GetBuildKitConnection",
      token,
      { buildId, platform: platformOf(platform) },
      BuildKitConnection,
    );
    if ("active" in connection) return connection.active;
    yield* Effect.sleep(Duration.millis(connection.pending.waitMs ?? 500));
  }
  return yield* new RemoteBuilderError({
    operation: "GetBuildKitConnection",
    message: `builder for build ${buildId} did not become active`,
  });
});

/**
 * Build `imageRef` from `contextDir` on a Fly remote builder and push it to
 * `registry` from there. Returns the builder's id: Machines created with it
 * as `fly_builder_id` metadata pull the image from the builder's registry
 * mirror before it finishes uploading to `registry.fly.io`.
 */
export const buildOnRemoteBuilder = Effect.fn(function* (input: {
  docker: Docker["Service"];
  appName: string;
  contextDir: string;
  imageRef: string;
  platform: string;
  registry: RegistryCredentials;
}) {
  const { buildId, buildToken } = yield* builders.ensureDepotRemoteBuilder({
    input: { appName: input.appName, builderScope: "app" },
  });
  const token = Redacted.isRedacted(buildToken) ? buildToken : Redacted.make(buildToken);
  const platform = platformOf(input.platform);

  const finish = (result: object) =>
    depot("FinishBuild", token, { buildId, ...result }, Schema.Unknown).pipe(Effect.ignore);

  return yield* Effect.gen(function* () {
    // Depot reclaims a builder that stops reporting health.
    yield* depot("ReportBuildHealth", token, { buildId, platform }, Schema.Unknown).pipe(
      Effect.ignore,
      Effect.repeat(Schedule.spaced(HEALTH_INTERVAL)),
      Effect.forkScoped,
    );
    const connection = yield* acquireConnection(buildId, token, input.platform);

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-fly-builder-" });
    const file = (name: string, content: string) =>
      fs
        .writeFileString(path.join(dir, name), content, { mode: 0o600 })
        .pipe(Effect.as(path.join(dir, name)));
    const cacert = yield* file("ca.pem", connection.caCert.cert);
    const cert = yield* file("cert.pem", connection.cert.cert);
    const key = yield* file("key.pem", connection.cert.key);

    const builder = `alchemy-fly-${buildId}`.replace(/[^a-zA-Z0-9_-]/g, "-");
    yield* Effect.acquireRelease(
      input.docker.run([
        "buildx",
        "create",
        "--name",
        builder,
        "--driver",
        "remote",
        "--driver-opt",
        `cacert=${cacert},cert=${cert},key=${key},servername=${connection.serverName}`,
        connection.endpoint,
      ]),
      () => input.docker.run(["buildx", "rm", builder]).pipe(Effect.ignore),
    );

    yield* input.docker.image
      .build(
        { context: input.contextDir, tag: input.imageRef, platform: input.platform },
        undefined,
        input.registry,
      )
      .pipe(
        Effect.provideService(DockerEnvironment, {
          BUILDX_BUILDER: builder,
          DOCKER_AUTH_CONFIG: JSON.stringify({
            auths: { [FLY_REGISTRY_MIRROR]: { auth: basicAuth(input.registry) } },
          }),
        }),
      );
    // The BuildKit worker's hostname, which is also its TLS server name.
    return { builderId: connection.serverName };
  }).pipe(
    Effect.scoped,
    Effect.tapError((error) => finish({ error: { error: String(error) } })),
    Effect.tap(() => finish({ success: {} })),
    Effect.onInterrupt(() => finish({ canceled: {} })),
  );
});
