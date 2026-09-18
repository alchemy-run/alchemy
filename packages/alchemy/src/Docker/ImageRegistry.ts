import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type { RegistryCredentials } from "./Docker.ts";

export class ImageRegistryError extends Schema.TaggedError<ImageRegistryError>()(
  "ImageRegistryError",
  {
    reason: Schema.Literals([
      "InvalidReference",
      "AuthenticationFailed",
      "ImageNotFound",
      "RequestFailed",
      "InvalidManifest",
    ]),
    message: Schema.String,
    status: Schema.optional(Schema.Number),
  },
) {}

/** Registry credentials resolved at operation time, rather than persisted tokens. */
export class RegistryAuth extends Context.Service<
  RegistryAuth,
  {
    readonly resolve: (
      server: string,
      permissions: ReadonlyArray<"pull" | "push">,
    ) => Effect.Effect<RegistryCredentials | undefined, ImageRegistryError>;
  }
>()("Docker.RegistryAuth") {}

/** Where to publish a built or mirrored image. */
export interface ImagePublish {
  /** Complete registry/repository path, without a tag or digest. */
  repository: string;
  /** Additional tags. Deployments always use the immutable digest reference. */
  tags?: string[];
  /** Explicit credentials. Otherwise use the registry integration or Docker config. */
  credentials?: {
    /** Registry authentication username. */
    username: string;
    /** Registry password or access token. */
    password: Redacted.Redacted<string>;
  };
}

const failure = (reason: ImageRegistryError["reason"], message: string) =>
  new ImageRegistryError({ reason, message });

export const parseImageReference = (reference: string) => {
  const digestAt = reference.lastIndexOf("@");
  const tagAt = reference.lastIndexOf(":");
  const slashAt = reference.lastIndexOf("/");
  const repository =
    digestAt >= 0
      ? reference.slice(0, digestAt)
      : tagAt > slashAt
        ? reference.slice(0, tagAt)
        : reference;
  const first = repository.split("/")[0]!;
  const qualified =
    repository.includes("/") &&
    (first.includes(".") || first.includes(":") || first === "localhost");
  const server = qualified ? first : "docker.io";
  const name = qualified ? repository.slice(first.length + 1) : repository;
  return {
    server,
    repository: `${server}/${server === "docker.io" && !name.includes("/") ? `library/${name}` : name}`,
    name:
      server === "docker.io" && !name.includes("/") ? `library/${name}` : name,
    selector:
      digestAt >= 0
        ? reference.slice(digestAt + 1)
        : tagAt > slashAt
          ? reference.slice(tagAt + 1)
          : "latest",
  };
};

export const validateImageRepository = (repository: string) => {
  const parsed = parseImageReference(repository);
  return parsed.repository === repository &&
    !repository.includes("@") &&
    repository.lastIndexOf(":") < repository.indexOf("/") &&
    /^[a-z0-9][a-z0-9._:/-]*$/.test(repository) &&
    parsed.name.length > 0
    ? Effect.succeed(parsed)
    : Effect.fail(
        failure(
          "InvalidReference",
          "Expected a fully qualified registry/repository without a tag or digest",
        ),
      );
};

const DockerConfig = Schema.Struct({
  auths: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({ auth: Schema.optional(Schema.String) }),
    ),
  ),
  credHelpers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  credsStore: Schema.optional(Schema.String),
});
const CredentialResult = Schema.Struct({
  Username: Schema.String,
  Secret: Schema.String,
});

const configCredentials = Effect.fn(
  function* (server: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* Effect.sync(
      () =>
        process.env.DOCKER_CONFIG ??
        path.join(process.env.HOME ?? ".", ".docker"),
    );
    const inline = yield* Effect.sync(() => process.env.DOCKER_AUTH_CONFIG);
    const filename = path.join(directory, "config.json");
    const decode = Schema.decodeUnknownEffect(
      Schema.fromJsonString(DockerConfig),
    );
    const disk = (yield* fs.exists(filename))
      ? yield* decode(yield* fs.readFileString(filename))
      : undefined;
    const configured = inline ? yield* decode(inline) : undefined;
    const key = server === "docker.io" ? "https://index.docker.io/v1/" : server;
    const auth =
      configured?.auths?.[server]?.auth ??
      configured?.auths?.[key]?.auth ??
      disk?.auths?.[server]?.auth ??
      disk?.auths?.[key]?.auth;
    if (auth !== undefined) {
      const decoded = Encoding.decodeBase64String(auth);
      if (Result.isFailure(decoded) || decoded.success.indexOf(":") < 1) {
        return yield* failure(
          "AuthenticationFailed",
          "Invalid Docker registry credentials",
        );
      }
      const colon = decoded.success.indexOf(":");
      return {
        server,
        username: decoded.success.slice(0, colon),
        password: Redacted.make(decoded.success.slice(colon + 1)),
      };
    }
    const helper = disk?.credHelpers?.[server] ?? disk?.credsStore;
    if (!helper) return undefined;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const input = yield* Effect.sync(() =>
      new TextEncoder().encode(`${key}\n`),
    );
    const child = yield* spawner.spawn(
      ChildProcess.make(`docker-credential-${helper}`, ["get"], {
        stdin: Stream.succeed(input),
      }),
    );
    const [output, , exit] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(child.stdout)),
        Stream.runDrain(child.stderr),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (exit !== 0) {
      if (output.trim() === "credentials not found in native keychain")
        return undefined;
      return yield* failure(
        "AuthenticationFailed",
        "Docker credential helper failed",
      );
    }
    const credentials = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(CredentialResult),
    )(output);
    if (!credentials.Username && !credentials.Secret) return undefined;
    return {
      server,
      username: credentials.Username,
      password: Redacted.make(credentials.Secret),
    };
  },
  Effect.scoped,
  Effect.mapError(() =>
    failure(
      "AuthenticationFailed",
      "Unable to read Docker registry credentials",
    ),
  ),
);

export const resolveRegistryCredentials = Effect.fn(function* (
  server: string,
  permissions: ReadonlyArray<"pull" | "push">,
  explicit?: ImagePublish["credentials"],
) {
  if (explicit) return { server, ...explicit };
  const integration = yield* Effect.serviceOption(RegistryAuth);
  if (integration._tag === "Some") {
    const credentials = yield* integration.value.resolve(server, permissions);
    if (credentials) return credentials;
  }
  return yield* configCredentials(server);
});

const Digest = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
);
const Token = Schema.Struct({
  token: Schema.optional(Schema.String),
  access_token: Schema.optional(Schema.String),
});

const requestManifest = Effect.fn(function* (
  reference: string,
  method: "HEAD" | "GET" | "PUT",
  credentials?: RegistryCredentials,
  content?: { text: string; type: string },
) {
  const parsed = parseImageReference(reference);
  if (!parsed.name || /\s/.test(reference))
    return yield* failure("InvalidReference", "Invalid image reference");
  const host =
    parsed.server === "docker.io" ? "registry-1.docker.io" : parsed.server;
  const protocol = /^(localhost|127\.0\.0\.1)(:|$)/.test(host)
    ? "http"
    : "https";
  const client = yield* HttpClient.HttpClient;
  const url = `${protocol}://${host}/v2/${parsed.name.split("/").map(encodeURIComponent).join("/")}/manifests/${encodeURIComponent(parsed.selector).replaceAll("%3A", ":")}`;
  let request = HttpClientRequest.make(method)(url).pipe(
    HttpClientRequest.setHeader(
      "Accept",
      "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json",
    ),
  );
  if (content)
    request = request.pipe(
      HttpClientRequest.bodyText(content.text, content.type),
    );
  const execute = (request: HttpClientRequest.HttpClientRequest) =>
    client.execute(request).pipe(
      Effect.mapError(() =>
        failure("RequestFailed", "Image registry request failed"),
      ),
      Effect.flatMap((response) =>
        response.status === 429 || response.status >= 500
          ? Effect.fail(
              new ImageRegistryError({
                reason: "RequestFailed",
                message: `Image registry returned HTTP ${response.status}`,
                status: response.status,
              }),
            )
          : Effect.succeed(response),
      ),
      Effect.retry({
        schedule: Schedule.spaced("500 millis"),
        times: 3,
        while: (error) => error.reason === "RequestFailed",
      }),
    );
  let response = yield* execute(
    credentials
      ? request.pipe(
          HttpClientRequest.basicAuth(
            credentials.username,
            credentials.password,
          ),
        )
      : request,
  );
  const challenge = response.headers["www-authenticate"];
  if (
    response.status === 401 &&
    challenge?.toLowerCase().startsWith("bearer ")
  ) {
    const fields = Object.fromEntries(
      Array.from(
        challenge.matchAll(/([a-z]+)="([^"]*)"/gi),
        ([, key, value]) => [key!.toLowerCase(), value!],
      ),
    );
    const realm = yield* Effect.try({
      try: () => new URL(fields.realm!),
      catch: () =>
        failure(
          "AuthenticationFailed",
          "Invalid registry authentication challenge",
        ),
    });
    if (
      realm.protocol !== "https:" &&
      !(protocol === "http" && realm.host === host)
    ) {
      return yield* failure(
        "AuthenticationFailed",
        "Registry authentication requires a secure token endpoint",
      );
    }
    if (fields.service) realm.searchParams.set("service", fields.service);
    realm.searchParams.set(
      "scope",
      `repository:${parsed.name}:${method === "PUT" ? "pull,push" : "pull"}`,
    );
    let tokenRequest = HttpClientRequest.get(realm.toString());
    if (credentials) {
      if (
        realm.host !== host &&
        !(parsed.server === "docker.io" && realm.host === "auth.docker.io")
      ) {
        return yield* failure(
          "AuthenticationFailed",
          "Refusing to forward registry credentials to another host",
        );
      }
      tokenRequest = tokenRequest.pipe(
        HttpClientRequest.basicAuth(credentials.username, credentials.password),
      );
    }
    const tokenResponse = yield* execute(tokenRequest);
    if (tokenResponse.status !== 200)
      return yield* new ImageRegistryError({
        reason:
          tokenResponse.status === 401 || tokenResponse.status === 403
            ? "AuthenticationFailed"
            : "RequestFailed",
        message: `Registry token request returned HTTP ${tokenResponse.status}`,
        status: tokenResponse.status,
      });
    const body = yield* tokenResponse.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Token)),
      Effect.mapError(() =>
        failure("AuthenticationFailed", "Invalid registry token response"),
      ),
    );
    const token = body.token ?? body.access_token;
    if (!token)
      return yield* failure(
        "AuthenticationFailed",
        "Registry token response is missing a token",
      );
    response = yield* execute(
      request.pipe(HttpClientRequest.bearerToken(Redacted.make(token))),
    );
  }
  if (response.status < 200 || response.status >= 300) {
    return yield* new ImageRegistryError({
      reason:
        response.status === 404
          ? "ImageNotFound"
          : response.status === 401 || response.status === 403
            ? "AuthenticationFailed"
            : "RequestFailed",
      message: `Image registry returned HTTP ${response.status}`,
      status: response.status,
    });
  }
  return response;
});

/** Read the registry's manifest identity without a Docker daemon or builder. */
export const resolveImageManifest = Effect.fn(function* (
  reference: string,
  credentials?: RegistryCredentials,
) {
  const parsed = parseImageReference(reference);
  const response = yield* requestManifest(reference, "HEAD", credentials);
  const digest = yield* Schema.decodeUnknownEffect(Digest)(
    response.headers["docker-content-digest"],
  ).pipe(
    Effect.mapError(() =>
      failure("InvalidManifest", "Registry manifest has no valid digest"),
    ),
  );
  return { ref: `${parsed.repository}@${digest}`, digest };
});

/** Add or update aliases without loading the published image into a daemon. */
export const syncImageTags = Effect.fn(function* (
  reference: string,
  tags: readonly string[],
  credentials?: RegistryCredentials,
) {
  const source = parseImageReference(reference);
  for (const tag of tags) {
    if (!/^[\w][\w.-]{0,127}$/.test(tag))
      return yield* failure("InvalidReference", "Invalid publication tag");
    const target = `${source.repository}:${tag}`;
    const current = yield* findImageManifest(target, credentials);
    if (current?.digest === source.selector) continue;
    const manifest = yield* requestManifest(reference, "GET", credentials);
    const text = yield* manifest.text.pipe(
      Effect.mapError(() =>
        failure("RequestFailed", "Failed to read image manifest"),
      ),
    );
    const type = manifest.headers["content-type"];
    if (!type)
      return yield* failure(
        "InvalidManifest",
        "Image manifest has no media type",
      );
    yield* requestManifest(target, "PUT", credentials, { text, type });
  }
});

export const findImageManifest = (
  reference: string,
  credentials?: RegistryCredentials,
) =>
  resolveImageManifest(reference, credentials).pipe(
    Effect.catchTag("ImageRegistryError", (error) =>
      error.reason === "ImageNotFound"
        ? Effect.succeed(undefined)
        : Effect.fail(error),
    ),
  );
