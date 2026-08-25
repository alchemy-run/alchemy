import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as NodeHttp from "node:http";
import * as NodeStream from "node:stream";
import { getAddress } from "./internal/get-address.ts";
import { ConfigError, SystemError } from "./RuntimeError.shared.ts";
import type * as WorkerdConfig from "./workerd/Config.ts";

export class Docker extends Context.Service<
  Docker,
  {
    readonly getWorkerdDockerConfiguration: Effect.Effect<
      WorkerdConfig.Worker_ContainerEngine,
      SystemError
    >;
    readonly generateImageTag: (className: string, suffix?: string) => string;
    readonly registerImageEnv: (
      className: string,
      tag: string,
      env: Record<string, string>,
    ) => Effect.Effect<string, never, Scope.Scope>;
    /**
     * Register a transform applied to every intercepted
     * `POST /containers/create` body (after image-alias/env rewriting,
     * before it reaches the Docker daemon). Services layered above
     * Docker use this to contribute create-time configuration — e.g.
     * the dev S3 gateway grants FUSE-marked containers the FUSE device
     * + capability and injects its own URL. Transforms run in
     * registration order; a rejected transform fails the create (502).
     */
    readonly registerContainerCreateTransform: (
      transform: ContainerCreateTransform,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly build: (
      tag: string,
      image: ContainerImage.Build,
    ) => Effect.Effect<void, SystemError>;
    readonly pull: (
      tag: string,
      image: ContainerImage.Pull,
    ) => Effect.Effect<void, SystemError>;
    readonly validate: (tag: string) => Effect.Effect<void, ConfigError>;
    readonly removeImageTag: (tag: string) => Effect.Effect<void>;
    readonly removeContainer: (tag: string) => Effect.Effect<void, SystemError>;
  }
>()("cloudflare-runtime/Docker") {}

/**
 * The subset of Docker's `ContainerCreateRequest` the create
 * interceptor works with. Unknown fields pass through untouched.
 */
export interface ContainerCreateBody {
  Image: string;
  Env?: Array<string>;
  HostConfig?: Record<string, unknown>;
  [key: string]: unknown;
}

export type ContainerCreateTransform = (
  body: ContainerCreateBody,
) => ContainerCreateBody | Promise<ContainerCreateBody>;

export type ContainerImage =
  | ContainerImage.Build
  | ContainerImage.Pull
  | ContainerImage.Ref;

export declare namespace ContainerImage {
  interface Base {
    readonly env?: Record<string, string>;
  }
  export interface Build extends Base {
    readonly dockerfile: string;
    readonly context?: string;
    readonly buildArgs?: Record<string, string>;
    /**
     * Docker platform for the build (`"linux/arm64"` for a native dev
     * image on Apple Silicon). Defaults to `linux/amd64` — production
     * parity with Cloudflare's container platform.
     */
    readonly platform?: string;
  }
  export interface Pull extends Base {
    readonly imageUri: string;
  }
  export interface Ref extends Base {
    readonly tag: string;
  }
}

const DEFAULT_DOCKER_HOST =
  process.platform === "win32"
    ? "//./pipe/docker_engine"
    : "unix:///var/run/docker.sock";
const DEV_CONTAINER_PREFIX = "alchemy-dev";

const DockerHost = Config.string("DOCKER_HOST");
const DockerBin = Config.string("DOCKER_BIN").pipe(
  Config.orElse(() => Config.succeed("docker")),
);
const ContainerEgressInterceptorImage = Config.string(
  "CONTAINER_EGRESS_INTERCEPTOR_IMAGE",
).pipe(
  Config.orElse(() =>
    Config.succeed(
      "cloudflare/proxy-everything:3cb1195@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8",
    ),
  ),
);

/**
 * Docker's containerd image store rejects combined `repo:tag@digest` pull
 * refs ("cannot overwrite digest"); the digest fully pins the image, so the
 * tag is dropped when both are present.
 */
export const toPullRef = (imageUri: string) =>
  imageUri.replace(/:[^@/]+(?=@sha256:)/, "");

/**
 * Hostname dev containers use to reach services listening on the developer's
 * machine. Inside a container, `localhost` is the container itself, so env
 * values that point at host-side services (a local dev database, another dev
 * server) are rewritten to this alias, which is mapped to Docker's
 * `host-gateway` on the container's network (see `makeDockerProxyServer`).
 *
 * Deliberately NOT `host.docker.internal`: several dev-oriented clients gate
 * "insecure local mode" on a localhost-looking hostname — notably Prisma's
 * client, which flips `prisma+postgres://` URLs to TLS unless the host
 * contains `localhost`/`127.0.0.1`/`[::1]` — and the local `@prisma/dev`
 * server only speaks plain HTTP. An alias under `.localhost` keeps those
 * heuristics intact while `/etc/hosts` (which `getaddrinfo` consults before
 * DNS) routes it to the host machine.
 *
 * Platform note: on Docker Desktop (macOS/Windows) `host-gateway` forwards
 * into the host's loopback, so services bound to `127.0.0.1` are reachable.
 * On native Linux Docker it resolves to the bridge gateway IP, so a host
 * service must listen on `0.0.0.0` (or the bridge address) to be reachable.
 */
export const CONTAINER_LOOPBACK_ALIAS = "host.docker.localhost";

/**
 * Matches a loopback host (`localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]`)
 * where it denotes a connection target inside an env value: at the start of
 * the value, after a `scheme://` (with optional userinfo), after `=` (DSN
 * keyword form, `host=localhost`), or after whitespace/comma/semicolon
 * delimiters — and followed by a port, path, delimiter, or the end.
 */
const LOOPBACK_HOST =
  /(^|[\s,;=]|\/\/(?:[^/\s@]*@)?)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?=[:/?#]|[\s,;]|$)/g;

/**
 * Rewrite loopback hosts in a container env value to
 * {@link CONTAINER_LOOPBACK_ALIAS} so the value keeps meaning "the developer's
 * machine" from inside the container. Applied to the env the Docker proxy
 * injects at container create (the deployment-level env registered via
 * `registerImageEnv`) — in production these values point at real cloud hosts,
 * so the rewrite only ever fires against local dev emulators.
 */
export const rewriteLoopbackHosts = (value: string) =>
  value.replace(LOOPBACK_HOST, `$1${CONTAINER_LOOPBACK_ALIAS}`);

export const DockerLive = Layer.effect(
  Docker,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const bin = yield* DockerBin;
    const containerEgressInterceptorImage =
      yield* ContainerEgressInterceptorImage;
    const registeredImages = new Map<
      string,
      { tag: string; env: Record<string, string> }
    >();
    const createTransforms = new Set<ContainerCreateTransform>();

    const getSocketPathFromContext = () =>
      ChildProcess.make(bin, ["context", "ls", "--format", "json"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: false,
      }).pipe(
        spawner.spawn,
        Effect.flatMap((child) =>
          child.stdout.pipe(
            Stream.decodeText,
            Stream.splitLines,
            Stream.filter((line) => line.trim() !== ""),
            Stream.map(
              (line) =>
                JSON.parse(line) as {
                  Current: boolean;
                  DockerEndpoint: string;
                },
            ),
            Stream.runCollect,
            Effect.flatMap((items) => {
              const endpoint = items.find(
                (item) => item.Current,
              )?.DockerEndpoint;
              return endpoint
                ? Effect.succeed(endpoint)
                : Effect.fail(
                    new ConfigError({
                      subtag: "DockerHostNotFound",
                      message: "Docker host not found",
                    }),
                  );
            }),
          ),
        ),
        Effect.scoped,
      );

    const makeDockerProxyServer = (socketPath: string) =>
      NodeHttp.createServer(async (req, res) => {
        const isCreateRequest =
          req.method === "POST" && req.url?.startsWith("/containers/create");
        // workerd creates two containers per instance: the user container and
        // a `<name>-proxy` networking sidecar whose namespace the user
        // container joins (`NetworkMode: container:<sidecar>`) — so the
        // sidecar's /etc/hosts is what the user container resolves against.
        const isSidecarCreateRequest =
          isCreateRequest && req.url!.endsWith("-proxy");
        if (isCreateRequest && !isSidecarCreateRequest) {
          const original = await extractJsonBody<{
            Image: string;
            Env: Array<string>;
          }>(req);
          const image = registeredImages.get(original.Image);
          let body: ContainerCreateBody = {
            ...original,
            Image: image?.tag ?? original.Image,
            Env: [
              ...(original.Env ?? []),
              ...Object.entries(image?.env ?? {}).map(
                ([name, value]) => `${name}=${rewriteLoopbackHosts(value)}`,
              ),
            ],
          };
          try {
            for (const transform of createTransforms) {
              body = await transform(body);
            }
          } catch (error) {
            // eslint-disable-next-line no-console -- workerd swallows the
            // 502 body; without this the failure is undebuggable
            console.error(
              `[docker-proxy] container create transform failed:`,
              error,
            );
            res.writeHead(502, { "content-type": "text/plain" });
            res.end(
              `Container create transform failed: ${(error as Error)?.message ?? error}`,
            );
            return;
          }
          const transformed = JSON.stringify(body);
          const proxy = sendProxyRequest({
            socketPath,
            path: req.url,
            method: req.method,
            headers: {
              ...req.headers,
              "content-length": Buffer.byteLength(transformed).toString(),
            },
            res,
            // a daemon rejection (400 on a bad HostConfig etc.) is
            // otherwise only visible inside workerd — surface it here
            onErrorResponse: (status, responseBody) =>
              console.error(
                `[docker-proxy] container create rejected (${status}): ${responseBody}`,
              ),
          });
          proxy.end(transformed);
        } else if (isSidecarCreateRequest) {
          // Map the loopback alias to the host machine in the shared network
          // namespace, alongside the `host.docker.internal:host-gateway`
          // entry workerd already sets on the sidecar.
          const original = await extractJsonBody<{
            HostConfig?: { ExtraHosts?: Array<string> };
          }>(req);
          const transformed = JSON.stringify({
            ...original,
            HostConfig: {
              ...original.HostConfig,
              ExtraHosts: [
                ...(original.HostConfig?.ExtraHosts ?? []),
                `${CONTAINER_LOOPBACK_ALIAS}:host-gateway`,
              ],
            },
          });
          const proxy = sendProxyRequest({
            socketPath,
            path: req.url,
            method: req.method,
            headers: {
              ...req.headers,
              "content-length": Buffer.byteLength(transformed).toString(),
            },
            res,
          });
          proxy.end(transformed);
        } else {
          const proxy = sendProxyRequest({
            socketPath,
            path: req.url,
            method: req.method,
            headers: req.headers,
            res,
          });
          req.pipe(proxy, { end: true });
        }
      });

    const run = (
      args: Array<string>,
      stdin: ChildProcess.CommandInput = "ignore",
    ) =>
      ChildProcess.make(bin, args, {
        stdin,
        stdout: "pipe",
        stderr: "pipe",
        detached: false,
      }).pipe(
        spawner.spawn,
        Effect.flatMap((child) =>
          Effect.all(
            {
              exitCode: child.exitCode,
              stdout: child.stdout.pipe(
                Stream.decodeText,
                Stream.tap(Effect.logDebug),
                Stream.mkString,
              ),
              stderr: child.stderr.pipe(
                Stream.decodeText,
                Stream.tap(Effect.logDebug),
                Stream.mkString,
              ),
            },
            { concurrency: "unbounded" },
          ),
        ),
        Effect.scoped,
      );

    const pull = ({ imageUri }: ContainerImage.Pull) =>
      run(["pull", toPullRef(imageUri), "--platform", "linux/amd64"]).pipe(
        Effect.mapError(
          (cause) =>
            new SystemError({
              subtag: "DockerPullFailed",
              message: `Failed to pull image "${imageUri}".`,
              hint: "Ensure Docker is running and the image is available.",
              detail: { bin, imageUri },
              cause,
            }),
        ),
        Effect.flatMap((result) => {
          if (result.exitCode !== 0) {
            return Effect.fail(
              new SystemError({
                subtag: "DockerPullFailed",
                message: `Failed to pull image "${imageUri}".`,
                hint: "Ensure Docker is running and the image is available.",
                detail: {
                  bin,
                  imageUri,
                  exitCode: result.exitCode,
                  stdout: result.stdout,
                  stderr: result.stderr,
                },
              }),
            );
          }
          return Effect.succeed(result.stdout);
        }),
      );

    const inspect = (tag: string, format: string) =>
      Effect.map(
        run(["image", "inspect", tag, "--format", format]),
        (result) => result.stdout,
      );

    const list = (ancestor: string) =>
      run([
        "ps",
        "-a",
        "--no-trunc",
        "--filter",
        `ancestor=${ancestor}`,
        "--format",
        "{{.ID}} {{.Names}} {{.Image}}",
      ]).pipe(
        Effect.map((result) =>
          result.stdout
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((line) => {
              const [id, name, image] = line.split(" ");
              return { id, name, image };
            })
            .filter((container) => container.image === ancestor),
        ),
      );

    const docker = yield* Effect.zipWith(
      DockerHost.pipe(
        Effect.catchTag("ConfigError", getSocketPathFromContext),
        Effect.orElseSucceed(() => DEFAULT_DOCKER_HOST),
        Effect.flatMap((socketPath) => {
          const server = makeDockerProxyServer(socketPath);
          server.listen(0);
          return getAddress(server);
        }),
      ),
      // Skip the eager pull when the interceptor image is already present
      // locally. `CONTAINER_EGRESS_INTERCEPTOR_IMAGE` can point at a
      // local-only tag that exists in the Docker daemon but resolves in no
      // registry (e.g. a locally-built dev image) — an unconditional
      // `docker pull` there fails, this detached fiber dies, and every
      // caller of `getWorkerdDockerConfiguration` (joined on first use)
      // fails with it. `docker image inspect` prints the image id when
      // present and empty stdout when absent (`run` reports the non-zero
      // exit rather than failing the effect), so only pull when the image
      // is genuinely missing. Any failure to even run `inspect` (unlike
      // `pull`, it doesn't normalize its error channel) falls back to the
      // pre-existing pull behavior rather than failing here.
      inspect(containerEgressInterceptorImage, "{{.Id}}").pipe(
        Effect.orElseSucceed(() => undefined),
        Effect.flatMap((imageId) =>
          imageId?.trim()
            ? Effect.void
            : pull({ imageUri: containerEgressInterceptorImage }),
        ),
      ),
      (socketPath) => ({
        localDocker: {
          socketPath,
          containerEgressInterceptorImage,
        },
      }),
      { concurrent: true },
    ).pipe(
      Effect.forkDetach({ startImmediately: false, uninterruptible: true }),
    );

    return Docker.of({
      getWorkerdDockerConfiguration: Fiber.join(docker),
      registerImageEnv: (className, tag, env) => {
        const alias = generateImageTag(className);
        return Effect.acquireRelease(
          Effect.sync(() => registeredImages.set(alias, { tag, env })),
          () => Effect.sync(() => registeredImages.delete(alias)),
        ).pipe(Effect.as(alias));
      },
      registerContainerCreateTransform: (transform) =>
        Effect.acquireRelease(
          Effect.sync(() => createTransforms.add(transform)),
          () => Effect.sync(() => createTransforms.delete(transform)),
        ).pipe(Effect.asVoid),
      generateImageTag,
      build: (tag, image) =>
        Effect.suspend(() => {
          const args = [
            "build",
            "--load",
            "-t",
            tag,
            "--platform",
            image.platform ?? "linux/amd64",
            "--provenance=false",
            ...Object.entries(image.buildArgs ?? {}).map(
              ([name, value]) => `--build-arg ${name}=${value}`,
            ),
            "-f",
            "-",
            path.resolve(image.context ?? path.dirname(image.dockerfile)),
          ];
          return run(
            args,
            fs.stream(
              image.context
                ? path.resolve(image.context, image.dockerfile)
                : path.resolve(image.dockerfile),
            ),
          ).pipe(
            Effect.withLogSpan(`docker: build ${tag}`),
            Effect.asVoid,
            Effect.mapError(
              (cause) =>
                new SystemError({
                  subtag: "DockerBuildFailed",
                  message: `Failed to build image "${tag}".`,
                  cause,
                }),
            ),
          );
        }),
      pull: (tag, image) =>
        pull(image).pipe(
          Effect.andThen(
            run(["tag", image.imageUri, tag]).pipe(
              Effect.mapError(
                (cause) =>
                  new SystemError({
                    subtag: "DockerTagFailed",
                    message: `Failed to tag image "${image.imageUri}" as "${tag}".`,
                    cause,
                  }),
              ),
            ),
          ),
          Effect.withLogSpan(`docker: pull ${image.imageUri}`),
          Effect.asVoid,
        ),
      validate: (tag) =>
        inspect(tag, "{{ len .Config.ExposedPorts }}").pipe(
          Effect.withLogSpan(`docker: inspect ${tag} for exposed ports`),
          Effect.orElseSucceed(() => "0"),
          Effect.flatMap((output) =>
            output === "0"
              ? Effect.fail(
                  new ConfigError({
                    subtag: "ContainerNoExposedPorts",
                    message: `The container for "${tag}" does not expose any ports.`,
                    hint: "Add an EXPOSE instruction to the Dockerfile for any ports you intend to connect to.",
                  }),
                )
              : Effect.void,
          ),
        ),
      // Untag ONLY the given tag (used by each runtime start's finalizer for
      // the tag it created). Deliberately does not guess at sibling
      // "<name>:<otherSuffix>" tags: concurrent/successive dev sessions of
      // the same container class each hold their own random-suffix tag on
      // the same underlying image, and pruning siblings untags an image a
      // live workerd still needs (its container creates then fail forever).
      removeImageTag: (tag) =>
        Effect.asVoid(run(["rmi", tag])).pipe(
          Effect.withLogSpan(`docker: remove image tag ${tag}`),
          Effect.ignore,
        ),
      removeContainer: (tag) =>
        list(tag).pipe(
          Effect.flatMap((containers) => {
            if (containers.length === 0) return Effect.void;
            return Effect.asVoid(
              run([
                "rm",
                "--force",
                ...containers.flatMap((container) => [
                  container.id,
                  `${container.name}-proxy`,
                ]),
              ]),
            );
          }),
          Effect.withLogSpan(`docker: remove containers for ${tag}`),
          Effect.mapError(
            (cause) =>
              new SystemError({
                subtag: "DockerRemoveContainerFailed",
                message: `Failed to remove containers for "${tag}".`,
                cause,
              }),
          ),
        ),
    });
  }),
);

const generateImageTag = (className: string, suffix?: string) =>
  `${DEV_CONTAINER_PREFIX}/${className.toLowerCase()}:${suffix ?? crypto.randomUUID().slice(0, 8)}`;

const sendProxyRequest = (input: {
  socketPath: string;
  path: string | undefined;
  method: string | undefined;
  headers: NodeHttp.OutgoingHttpHeaders;
  res: NodeHttp.ServerResponse;
  /** Observe a >=400 daemon response (status, collected body). */
  onErrorResponse?: (status: number, body: string) => void;
}) => {
  // `transfer-encoding` is a hop-by-hop header and must not be forwarded
  // verbatim. workerd sends its `DELETE /containers/<name>-proxy?force=true`
  // cleanup request with `transfer-encoding: chunked` and an empty body;
  // Bun's `node:http` client hangs indefinitely on such a request to a
  // unix socket (it never flushes the terminating zero-chunk), so the
  // docker daemon never responds and workerd blocks forever before it can
  // create the container. Strip the header and let the runtime derive the
  // framing from the body we actually write. (Node tolerates it, Bun does
  // not — and Alchemy dev runs the runtime under Bun.)
  delete input.headers["transfer-encoding"];
  const req = NodeHttp.request(
    {
      socketPath: input.socketPath.replace(/^unix:/, ""),
      path: input.path,
      method: input.method,
      headers: input.headers,
    },
    (res) => {
      delete res.headers["transfer-encoding"];
      input.res.writeHead(res.statusCode || 500, res.headers);
      if (input.onErrorResponse && (res.statusCode ?? 500) >= 400) {
        const status = res.statusCode ?? 500;
        const chunks: Array<Buffer> = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          input.onErrorResponse!(
            status,
            Buffer.concat(chunks).toString("utf8"),
          ),
        );
      }
      res.pipe(input.res, { end: true });
    },
  );
  req.on("error", (err) => {
    input.res.writeHead(502, { "content-type": "text/plain" });
    input.res.end(`Proxy error: ${(err && err.message) || err}`);
  });
  return req;
};

const extractJsonBody = <T>(req: NodeHttp.IncomingMessage) => {
  const promise = Promise.withResolvers<T>();
  const chunks: Array<Buffer> = [];
  req.pipe(
    new NodeStream.Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
      final(callback) {
        promise.resolve(JSON.parse(Buffer.concat(chunks).toString()));
        callback();
      },
    }),
    { end: true },
  );
  return promise.promise;
};
