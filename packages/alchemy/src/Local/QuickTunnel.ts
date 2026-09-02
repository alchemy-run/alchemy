import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { rootDir } from "../Auth/Paths.ts";
import { UserFacingError } from "../UserFacingError.ts";

/**
 * Cloudflare quick tunnels (`https://<random>.trycloudflare.com`) exposed
 * through the official `cloudflared` binary. Quick tunnels are free and need
 * no Cloudflare account; each `cloudflared tunnel --url …` process serves
 * exactly one public hostname, so the dev ingress opens one per exposed
 * local host and pins the origin `Host` header with `--http-host-header`.
 *
 * The binary is resolved from `$ALCHEMY_CLOUDFLARED`, then `$PATH`, then
 * `~/.alchemy/bin`; when none has it, the pinned release is downloaded from
 * GitHub so users never have to install cloudflared themselves.
 */
export class QuickTunnel extends Context.Service<
  QuickTunnel,
  {
    /**
     * Open a quick tunnel to `target`, optionally overriding the `Host`
     * header cloudflared sends to the origin. The tunnel process lives in
     * the ambient scope; the returned URL is the public hostname.
     */
    readonly open: (
      input: OpenTunnelInput,
    ) => Effect.Effect<OpenedTunnel, QuickTunnelError, Scope.Scope>;
  }
>()("alchemy/Local/QuickTunnel") {}

export interface OpenTunnelInput {
  /** The local origin the tunnel forwards to (e.g. the dev ingress). */
  readonly target: URL;
  /** `Host` header cloudflared sends to the origin (`--http-host-header`). */
  readonly hostHeader?: string;
  /** Sink for cloudflared's own log lines. */
  readonly onOutput?: (line: string) => Effect.Effect<void>;
}

export interface OpenedTunnel {
  /** The public `https://*.trycloudflare.com` URL. */
  readonly url: URL;
  /**
   * Resolves when the cloudflared process exits on its own (network drop,
   * kill). A quick tunnel's hostname is not recoverable — callers reopen.
   */
  readonly exited: Effect.Effect<void>;
}

export class QuickTunnelError extends Data.TaggedError("QuickTunnelError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {
  readonly [UserFacingError] = true;
}

/** Pinned cloudflared release downloaded when no binary is available. */
export const CLOUDFLARED_VERSION = "2026.8.3";

const TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/** cloudflared prints its fatal quick-tunnel errors with these markers. */
const FATAL_PATTERNS = [
  /failed to request quick Tunnel/i,
  /failed to unmarshal quick Tunnel/i,
  /Unable to reach the origin service/i,
] as const;

/** How long we wait for the public hostname before giving up. */
const READY_TIMEOUT = "45 seconds";

const isWindows = process.platform === "win32";

/** GitHub release asset name for this machine, or `undefined` when unsupported. */
export const releaseAsset = (
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
):
  | { readonly asset: string; readonly archive: "tgz" | "binary" }
  | undefined => {
  const goArch: Record<string, string> = {
    x64: "amd64",
    arm64: "arm64",
    ia32: "386",
    arm: "arm",
  };
  const mapped = goArch[arch];
  if (mapped === undefined) return undefined;
  switch (platform) {
    case "darwin":
      return { asset: `cloudflared-darwin-${mapped}.tgz`, archive: "tgz" };
    case "linux":
      return { asset: `cloudflared-linux-${mapped}`, archive: "binary" };
    case "win32":
      return { asset: `cloudflared-windows-${mapped}.exe`, archive: "binary" };
    default:
      return undefined;
  }
};

export const releaseUrl = (asset: string, version = CLOUDFLARED_VERSION) =>
  `https://github.com/cloudflare/cloudflared/releases/download/${version}/${asset}`;

const binaryName = isWindows ? "cloudflared.exe" : "cloudflared";

/** Where downloaded binaries live: `~/.alchemy/bin/cloudflared-<version>[.exe]`. */
export const managedBinaryPath = (
  path: Path.Path,
  version = CLOUDFLARED_VERSION,
) =>
  path.join(
    rootDir(),
    "bin",
    isWindows ? `cloudflared-${version}.exe` : `cloudflared-${version}`,
  );

const findOnPath = Effect.fn("QuickTunnel.findOnPath")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = (process.env.PATH ?? "").split(isWindows ? ";" : ":");
  for (const dir of entries) {
    if (dir === "") continue;
    const candidate = path.join(dir, binaryName);
    if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
      return candidate;
    }
  }
  return undefined;
});

const download = Effect.fn("QuickTunnel.download")(function* (
  destination: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const release = releaseAsset();
  if (release === undefined) {
    return yield* new QuickTunnelError({
      message: `No cloudflared release is available for ${process.platform}/${process.arch}. Install cloudflared manually and set ALCHEMY_CLOUDFLARED to its path.`,
    });
  }
  const url = releaseUrl(release.asset);
  yield* Effect.logInfo(
    `Downloading cloudflared ${CLOUDFLARED_VERSION} from ${url}`,
  );
  const downloadError = (cause: unknown) =>
    new QuickTunnelError({
      message: `Downloading cloudflared from ${url} failed. Install cloudflared manually or set ALCHEMY_CLOUDFLARED.`,
      cause,
    });
  const bytes: ArrayBuffer = yield* client.get(url).pipe(
    Effect.mapError(downloadError),
    Effect.flatMap((response) =>
      response.status === 200
        ? response.arrayBuffer.pipe(Effect.mapError(downloadError))
        : Effect.fail(
            new QuickTunnelError({
              message: `Downloading cloudflared failed with HTTP ${response.status} (${url}).`,
            }),
          ),
    ),
  );
  const dir = path.dirname(destination);
  yield* fs
    .makeDirectory(dir, { recursive: true })
    .pipe(
      Effect.mapError(
        (cause) =>
          new QuickTunnelError({ message: `Could not create ${dir}.`, cause }),
      ),
    );
  const ioError = (message: string) => (cause: unknown) =>
    new QuickTunnelError({ message, cause });
  if (release.archive === "tgz") {
    const tmpDir = yield* fs
      .makeTempDirectoryScoped({ prefix: "alchemy-cloudflared-" })
      .pipe(Effect.mapError(ioError("Could not create a temp directory.")));
    const archive = path.join(tmpDir, release.asset);
    yield* fs
      .writeFile(archive, new Uint8Array(bytes))
      .pipe(Effect.mapError(ioError(`Could not write ${archive}.`)));
    const exitCode = yield* spawner
      .exitCode(ChildProcess.make("tar", ["-xzf", archive, "-C", tmpDir]))
      .pipe(
        Effect.mapError(ioError("Could not run `tar` to extract cloudflared.")),
      );
    if (exitCode !== 0) {
      return yield* new QuickTunnelError({
        message: `Extracting ${release.asset} failed (tar exited with ${exitCode}).`,
      });
    }
    yield* fs
      .rename(path.join(tmpDir, "cloudflared"), destination)
      .pipe(
        Effect.mapError(
          ioError(`Could not move cloudflared to ${destination}.`),
        ),
      );
  } else {
    yield* fs
      .writeFile(destination, new Uint8Array(bytes))
      .pipe(Effect.mapError(ioError(`Could not write ${destination}.`)));
  }
  if (!isWindows) {
    yield* fs
      .chmod(destination, 0o755)
      .pipe(
        Effect.mapError(ioError(`Could not make ${destination} executable.`)),
      );
  }
  return destination;
}, Effect.scoped);

/**
 * Locate a cloudflared binary, downloading the pinned release when needed.
 * Resolution order: `$ALCHEMY_CLOUDFLARED`, `$PATH`, `~/.alchemy/bin`.
 */
export const resolveCloudflared = Effect.fn("QuickTunnel.resolveCloudflared")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const override = process.env.ALCHEMY_CLOUDFLARED;
    if (override !== undefined && override !== "") {
      return override;
    }
    const onPath = yield* findOnPath();
    if (onPath !== undefined) return onPath;
    const managed = managedBinaryPath(path);
    if (yield* fs.exists(managed).pipe(Effect.orElseSucceed(() => false))) {
      return managed;
    }
    return yield* download(managed);
  },
);

export const layer = Layer.effect(
  QuickTunnel,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const services = yield* Effect.context<
      | FileSystem.FileSystem
      | Path.Path
      | HttpClient.HttpClient
      | ChildProcessSpawner.ChildProcessSpawner
    >();
    // One download at a time; the resolved path is cached for the process.
    const resolveLock = Semaphore.makeUnsafe(1);
    let resolved: string | undefined;
    const binary = Effect.gen(function* () {
      if (resolved !== undefined) return resolved;
      resolved = yield* resolveCloudflared().pipe(
        Effect.provideContext(services),
      );
      return resolved;
    }).pipe(resolveLock.withPermits(1));

    return QuickTunnel.of({
      open: Effect.fn("QuickTunnel.open")(function* (
        input: OpenTunnelInput,
      ): Effect.fn.Return<OpenedTunnel, QuickTunnelError, Scope.Scope> {
        const bin = yield* binary;
        const args = [
          "tunnel",
          "--url",
          input.target.toString(),
          "--no-autoupdate",
          ...(input.hostHeader ? ["--http-host-header", input.hostHeader] : []),
        ];
        const handle = yield* spawner
          .spawn(
            ChildProcess.make(bin, args, {
              stdout: "pipe",
              stderr: "pipe",
              extendEnv: true,
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new QuickTunnelError({
                  message: `Could not start cloudflared (${bin}).`,
                  cause,
                }),
            ),
          );
        const ready = yield* Deferred.make<URL, QuickTunnelError>();
        const exited = yield* Deferred.make<void>();
        const watch = (source: Stream.Stream<Uint8Array, unknown>) =>
          source.pipe(
            Stream.decodeText,
            Stream.splitLines,
            Stream.runForEach((line) =>
              Effect.gen(function* () {
                if (input.onOutput) yield* input.onOutput(line);
                if (Deferred.isDoneUnsafe(ready)) return;
                const match = line.match(TUNNEL_URL_PATTERN);
                if (match) {
                  yield* Deferred.succeed(ready, new URL(match[0]));
                  return;
                }
                if (FATAL_PATTERNS.some((pattern) => pattern.test(line))) {
                  yield* Deferred.fail(
                    ready,
                    new QuickTunnelError({
                      message: `cloudflared could not open a quick tunnel: ${line.trim()}`,
                    }),
                  );
                }
              }),
            ),
            Effect.ignore,
            Effect.forkScoped,
          );
        yield* watch(handle.stdout);
        yield* watch(handle.stderr);
        yield* handle.exitCode.pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.andThen(
              Deferred.succeed(exited, undefined),
              Deferred.fail(
                ready,
                new QuickTunnelError({
                  message: `cloudflared exited before the tunnel came up (${
                    exit._tag === "Success"
                      ? `exit code ${exit.value}`
                      : "failed"
                  }).`,
                }),
              ),
            ),
          ),
          Effect.forkScoped,
        );
        const url = yield* Deferred.await(ready).pipe(
          Effect.timeoutOrElse({
            duration: READY_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new QuickTunnelError({
                  message: `cloudflared did not report a trycloudflare.com URL within ${READY_TIMEOUT}.`,
                }),
              ),
          }),
        );
        return { url, exited: Deferred.await(exited) };
      }),
    });
  }),
);
