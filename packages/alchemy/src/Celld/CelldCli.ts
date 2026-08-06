/**
 * Managed acquisition and invocation of the `celld` CLI.
 *
 * `celld deploy` is a pure bucket write (no fleet network access), so the
 * Worker provider shells out to a pinned release binary, cached under
 * `~/.alchemy/bin/celld/{version}/`.
 *
 * **On esbuild**: rolldown is alchemy's bundler — the staged project's
 * `main` is already our flat Worker bundle. celld v0.1.0 has no
 * prebundled-input path: its deploy unconditionally runs an esbuild it is
 * pointed at (`CELLD_ESBUILD`) over the project. The exact invocation
 * (captured empirically) is
 *
 * ```
 * esbuild worker.js --bundle --format=esm --platform=browser
 *   --target=es2024 --conditions=workerd,worker,browser
 *   --external:node:* --external:cloudflare:*
 * ```
 *
 * i.e. a benign flatten: it inlines our own relative chunk imports into one
 * file, keeps the runtime modules external, and does NOT minify — so no
 * identifier re-mangling on top of our `keepNames` output and ESM
 * evaluation order is preserved. The cost is a second parse and the loss of
 * sourcemaps across the flatten. `esbuild` is an optional peer dependency
 * (catalog-managed): only Celld deploys need it.
 *
 * @internal not exported from the Celld barrel.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

/** The pinned default celld release. */
export const DEFAULT_CELLD_VERSION = "0.1.0";

/**
 * The default celld container image for fleet nodes — pinned by digest (the
 * registry currently publishes only `latest`; this digest corresponds to the
 * v0.1.0 release).
 */
export const DEFAULT_CELLD_IMAGE =
  "ghcr.io/denoland/celld@sha256:2ba7fdeb91041a7e090027cf9d922b7b628e1fa0bb83818dcde059004ab809c8";

export class CelldDownloadError extends Data.TaggedError(
  "Celld.DownloadError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class CelldDeployError extends Data.TaggedError("Celld.DeployError")<{
  readonly message: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {}

export class EsbuildNotFoundError extends Data.TaggedError(
  "Celld.EsbuildNotFoundError",
)<{
  readonly message: string;
}> {}

const releaseTriple = Effect.sync(() => {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const os =
    process.platform === "darwin" ? "apple-darwin" : "unknown-linux-gnu";
  return `${arch}-${os}`;
});

/**
 * Resolve the esbuild binary celld hands its bundling step. `esbuild` is a
 * dependency of the alchemy package, so this resolves in any consuming
 * project; a custom binary wins via `CELLD_ESBUILD`.
 */
export const resolveEsbuild: Effect.Effect<string, EsbuildNotFoundError> =
  Effect.suspend(() => {
    if (process.env.CELLD_ESBUILD) {
      return Effect.succeed(process.env.CELLD_ESBUILD);
    }
    // Prefer the NATIVE platform binary: `esbuild/bin/esbuild` is a
    // `#!/usr/bin/env node` wrapper, which fails in the deploy child's
    // minimal environment (and on node-less bun installs).
    const nativePackage = `@esbuild/${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}/bin/esbuild`;
    for (const candidate of [nativePackage, "esbuild/bin/esbuild"]) {
      try {
        return Effect.succeed(require.resolve(candidate));
      } catch {
        // try the next candidate
      }
    }
    return Effect.fail(
      new EsbuildNotFoundError({
        message:
          "celld deploy requires esbuild (an optional peer dependency of alchemy). Add `esbuild` to your project's devDependencies, or point CELLD_ESBUILD at an esbuild binary.",
      }),
    );
  });

/**
 * Download (or reuse) the pinned celld release binary. Cached at
 * `~/.alchemy/bin/celld/{version}/celld`; the download is streamed to a temp
 * file, gunzipped, chmod'ed, and atomically renamed so concurrent acquires
 * never observe a partial binary.
 */
export const acquireCelld = (
  version: string = DEFAULT_CELLD_VERSION,
): Effect.Effect<
  string,
  CelldDownloadError,
  FileSystem.FileSystem | Path.Path | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* Effect.sync(
      () => process.env.HOME ?? process.env.USERPROFILE ?? ".",
    );
    const dir = path.join(home, ".alchemy", "bin", "celld", version);
    const bin = path.join(dir, "celld");

    if (yield* fs.exists(bin).pipe(Effect.orElseSucceed(() => false))) {
      return bin;
    }

    const triple = yield* releaseTriple;
    const url = `https://github.com/denoland/celld/releases/download/v${version}/celld-${triple}.gz`;
    const client = yield* HttpClient.HttpClient;

    yield* fs
      .makeDirectory(dir, { recursive: true })
      .pipe(Effect.catch(() => Effect.void));

    const response = yield* client.get(url).pipe(
      Effect.mapError(
        (cause) =>
          new CelldDownloadError({
            message: `Failed to download celld ${version} from ${url}`,
            cause,
          }),
      ),
    );
    if (response.status !== 200) {
      return yield* Effect.fail(
        new CelldDownloadError({
          message: `Failed to download celld ${version} from ${url}: HTTP ${response.status}`,
        }),
      );
    }
    const gz = yield* response.arrayBuffer.pipe(
      Effect.mapError(
        (cause) =>
          new CelldDownloadError({
            message: `Failed to read celld ${version} download body`,
            cause,
          }),
      ),
    );
    const binary = yield* Effect.try({
      try: () => {
        const zlib = require("node:zlib") as typeof import("node:zlib");
        return new Uint8Array(zlib.gunzipSync(Buffer.from(gz)));
      },
      catch: (cause) =>
        new CelldDownloadError({
          message: `Failed to gunzip the celld ${version} release asset`,
          cause,
        }),
    });

    const temp = `${bin}.tmp-${process.pid}`;
    yield* fs.writeFile(temp, binary).pipe(
      Effect.andThen(fs.chmod(temp, 0o755)),
      Effect.andThen(fs.rename(temp, bin)),
      Effect.mapError(
        (cause) =>
          new CelldDownloadError({
            message: `Failed to install celld ${version} to ${bin}`,
            cause,
          }),
      ),
    );
    return bin;
  });

export interface CelldDeployOptions {
  /** The staged wrangler project directory. */
  readonly projectDir: string;
  /** The fleet bucket, `s3://name`. */
  readonly bucket: string;
  /** Optional S3-compatible endpoint (MinIO, R2, …). */
  readonly endpoint?: string;
  /** The bucket's region. */
  readonly region?: string;
  /**
   * Environment for the child process — must carry standard-chain AWS
   * credentials (celld does not read profiles or SSO caches).
   */
  readonly env: Record<string, string>;
  /** celld release to run. */
  readonly version?: string;
}

/**
 * Run `celld deploy` against the staged project. Returns the deployment
 * version id parsed from the CLI output.
 */
export const celldDeploy = (
  options: CelldDeployOptions,
): Effect.Effect<
  { versionId: string | undefined },
  CelldDeployError | CelldDownloadError | EsbuildNotFoundError,
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const bin = yield* acquireCelld(options.version);
    const esbuild = yield* resolveEsbuild;

    const args = [
      "deploy",
      ".",
      "--bucket",
      options.bucket,
      ...(options.endpoint ? ["--endpoint", options.endpoint] : []),
      ...(options.region ? ["--region", options.region] : []),
    ];

    const result = yield* ChildProcess.make(bin, args, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: false,
      cwd: options.projectDir,
      env: {
        // PATH for the esbuild fallback wrapper (`#!/usr/bin/env node`).
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...options.env,
        CELLD_ESBUILD: esbuild,
      },
      // The child env is exactly what the adapter resolved — profiles/SSO
      // state in the parent env must not leak into the standard chain.
      extendEnv: false,
    }).pipe(
      spawner.spawn,
      Effect.flatMap((child) =>
        Effect.all(
          {
            exitCode: child.exitCode,
            stdout: child.stdout.pipe(Stream.decodeText, Stream.mkString),
            stderr: child.stderr.pipe(Stream.decodeText, Stream.mkString),
          },
          { concurrency: "unbounded" },
        ),
      ),
      // The spawned child is a scoped resource whose lifecycle ends with
      // this read-to-completion — own the scope here.
      Effect.scoped,
      Effect.mapError(
        (cause) =>
          new CelldDeployError({
            message: `celld deploy failed to spawn: ${String(cause)}`,
            exitCode: -1,
            stdout: "",
            stderr: "",
          }),
      ),
    );

    if (result.exitCode !== 0) {
      return yield* Effect.fail(
        new CelldDeployError({
          message: `celld deploy exited with code ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
          exitCode: Number(result.exitCode),
          stdout: result.stdout,
          stderr: result.stderr,
        }),
      );
    }

    const versionId = result.stdout.match(
      /Current Version ID:\s*([0-9a-f]+)/,
    )?.[1];
    return { versionId };
  });
