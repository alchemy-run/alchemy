import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/unstable/process";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { R2Tigrisfs } from "../Cloudflare/R2/Tigrisfs.ts";
import { Host } from "../Docker/Host.ts";
import {
  Mount,
  MountError,
  type Bucket,
  type MountHandle,
  type MountOptions,
} from "./Mount.ts";

// ---------------------------------------------------------------------------
// The strategy seam — the ONLY cloud-specific piece of a tigrisfs mount
// ---------------------------------------------------------------------------

/**
 * How tigrisfs gets authority over one bucket. {@link MountTigrisfs}
 * routes to a strategy per bucket resource type; the strategies live
 * with their clouds (`Cloudflare.R2.R2Tigrisfs` mints a scoped token
 * and derives S3 keys; the AWS S3 strategy binds IAM policy statements
 * onto the host's execution role and lets the ambient credential chain
 * work at runtime). Strategies import this module's types ONLY (a
 * type-only edge, erased at runtime — no cycle with the router below).
 */
export interface TigrisfsStrategy {
  /**
   * Plan-time: attach whatever the mount needs to the host — bound
   * credential env vars, IAM policy statements, dev markers. Runs
   * inside the host's `.make()` init at plan.
   */
  readonly plan: (
    bucket: Bucket,
    options: MountOptions | undefined,
  ) => Effect.Effect<void>;
  /**
   * Runtime: resolve where and how tigrisfs mounts — endpoint,
   * credentials (absent = the ambient AWS credential chain), and
   * strategy-specific flags.
   */
  readonly runtime: (
    bucket: Bucket,
    options: MountOptions | undefined,
  ) => Effect.Effect<TigrisfsTarget>;
}

/** What a {@link TigrisfsStrategy} resolves at runtime. */
export interface TigrisfsTarget {
  /** `bucket` or `bucket:prefix` (alias-encoded where names need it). */
  readonly bucket: string;
  readonly endpoint: string;
  /** Absent → tigrisfs uses the ambient AWS credential chain. */
  readonly accessKeyId?: string;
  readonly secretAccessKey?: Redacted.Redacted<string>;
  /** Strategy flags, prepended before caller `args`. */
  readonly args?: ReadonlyArray<string>;
}

/**
 * The strategy for one bucket resource type.
 *
 * NOTE: this static routing bundles every strategy's plan-time wiring
 * into the host image even though only one branch runs there. The
 * planned mitigation is a dynamic `import()` under the
 * `__ALCHEMY_RUNTIME__` guard, so unused strategies ship as never-loaded
 * chunks — deferred until the cost is felt (container/VM images, unlike
 * Workers, barely notice).
 */
const strategyFor = (bucket: Bucket): Effect.Effect<TigrisfsStrategy> => {
  switch (bucket.Type) {
    case "Cloudflare.R2.Bucket":
      return Effect.succeed(R2Tigrisfs);
    case "AWS.S3.Bucket":
      return Effect.die(
        new MountError({
          message:
            "the AWS S3 tigrisfs strategy is not implemented yet — it lands with the MicroVM sandbox work (IAM policy statements bound onto the host's execution role; the ambient credential chain at runtime).",
        }),
      );
    default:
      return Effect.die(
        new MountError({
          message: `FUSE.MountTigrisfs has no strategy for '${bucket.Type}' — it mounts object-storage buckets (Cloudflare R2 today).`,
        }),
      );
  }
};

// ---------------------------------------------------------------------------
// The layer
// ---------------------------------------------------------------------------

/**
 * The tigrisfs implementation of {@link Mount} — ONE layer for every
 * supported cloud: the mount machinery, the image contribution, and
 * the mountpoint policy are cloud-agnostic, and the only per-cloud
 * branch is how tigrisfs gets authority over the bucket (a
 * {@link TigrisfsStrategy}, resolved from the bucket's resource type):
 *
 * - **Cloudflare R2** — mints a scoped `AccountApiToken`, derives R2's
 *   S3 credentials from it, and binds them into the host's
 *   environment (`Cloudflare.R2.R2Tigrisfs`). Under `alchemy dev` the
 *   mount targets the dev session's local S3 gateway instead.
 * - **AWS S3** (pending) — binds IAM policy statements onto the host's
 *   execution role at plan time; at runtime tigrisfs uses the ambient
 *   credential chain, no keys involved.
 *
 * The binding carries its OWN system dependencies: at plan time it
 * contributes the `fuse3` + `tigrisfs` install to the host's image
 * (`Docker.Host` — provided by any image-generating platform), so the
 * host `.make()` needs no Dockerfile at all.
 *
 * ```ts
 * import * as FUSE from "alchemy/FUSE";
 *
 * export default Box.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const persist = yield* FUSE.Mount(Bucket, { path: "/persist" });
 *     // ...
 *   }).pipe(Effect.provide(FUSE.MountTigrisfs)),
 * );
 * ```
 */
export const MountTigrisfs = Layer.effect(
  Mount,
  Effect.gen(function* () {
    const services = yield* Effect.context<
      FileSystem.FileSystem | ChildProcessSpawner
    >();

    return Effect.fn(function* (bucket: Bucket, options?: MountOptions) {
      // LogicalId is static, so the default is deterministic in BOTH
      // phases (plan needs it before the bucket name is known)
      const path = options?.path ?? `/mnt/${bucket.LogicalId}`;
      const strategy = yield* strategyFor(bucket);

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        // ── plan ──
        // The mount's system dependencies ride the BINDING: contribute
        // the fuse3 + tigrisfs install to the host's image (Docker.Host
        // — provided by any image-generating platform: Cloudflare
        // Container, AWS MicroVM, ECS Task, …), so no image needs FUSE
        // knowledge to bind a mount.
        yield* Effect.serviceOption(Host).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.die(
                  new MountError({
                    message:
                      "FUSE.Mount must be bound inside an image-generating host's `.make()` init (a Cloudflare Container, AWS MicroVM, ECS Task, …) — no Docker.Host to install tigrisfs into.",
                  }),
                ),
              onSome: (host) => host.install(tigrisfsInstall),
            }),
          ),
        );
        yield* strategy.plan(bucket, options);
        return { path } satisfies MountHandle;
      }

      // ── runtime — a machine that cannot mount its persistence is not
      // viable: mount failures die (crash init) rather than fail ──
      const target = yield* strategy.runtime(bucket, options);
      yield* mountTigrisfs({
        path,
        bucket: target.bucket,
        endpoint: target.endpoint,
        accessKeyId: target.accessKeyId,
        secretAccessKey: target.secretAccessKey,
        args: [...(target.args ?? []), ...(options?.args ?? [])],
        readyTimeout: options?.readyTimeout ?? DEFAULT_READY_TIMEOUT_MS,
      }).pipe(Effect.provide(services), Effect.orDie);

      return { path } satisfies MountHandle;
    });
  }),
);

// ---------------------------------------------------------------------------
// The machinery — one consumer (the layer above), cloud-free
// ---------------------------------------------------------------------------

export const DEFAULT_READY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

/** Is `path` a mountpoint? Read from `/proc/mounts` (Linux only). */
const isMounted = (
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<boolean> =>
  fs.readFileString("/proc/mounts").pipe(
    Effect.map((mounts) =>
      mounts.split("\n").some((line) => line.split(" ")[1] === path),
    ),
    Effect.catch(() => Effect.succeed(false)),
  );

const collect = (
  stream: Stream.Stream<Uint8Array, unknown>,
): Effect.Effect<string, unknown> =>
  stream.pipe(Stream.decodeText, Stream.mkString);

/**
 * Run `tigrisfs` and wait for the mount. Credentials are optional —
 * absent, tigrisfs falls through to the ambient AWS credential chain
 * (env, ECS container-credentials endpoint, IMDS). tigrisfs daemonizes
 * by default — the parent process exits `0` only after the daemon has
 * signalled the filesystem is mounted — so a clean exit IS readiness;
 * the `/proc/mounts` poll below is belt-and-braces against adapter
 * regressions.
 */
const mountTigrisfs = (config: {
  readonly path: string;
  /** `bucket` or `bucket:prefix`. */
  readonly bucket: string;
  readonly endpoint: string;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: Redacted.Redacted<string>;
  readonly args: ReadonlyArray<string>;
  readonly readyTimeout: number;
}): Effect.Effect<
  void,
  MountError,
  FileSystem.FileSystem | ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // idempotent: a re-run of the init effect on an already-mounted
    // machine (e.g. a bridge rebuilding its layer stack) is a no-op
    if (yield* isMounted(fs, config.path)) return;
    yield* fs.makeDirectory(config.path, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new MountError({
            message: `cannot create mountpoint ${config.path}`,
            cause,
          }),
      ),
    );

    const [exitCode, stdout, stderr] = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* ChildProcess.make(
          "tigrisfs",
          [
            "--endpoint",
            config.endpoint,
            ...config.args,
            config.bucket,
            config.path,
          ],
          {
            env: {
              ...(config.accessKeyId !== undefined
                ? { AWS_ACCESS_KEY_ID: config.accessKeyId }
                : {}),
              ...(config.secretAccessKey !== undefined
                ? {
                    AWS_SECRET_ACCESS_KEY: Redacted.value(
                      config.secretAccessKey,
                    ),
                  }
                : {}),
            },
            extendEnv: true,
          },
        );
        return yield* Effect.all(
          [handle.exitCode, collect(handle.stdout), collect(handle.stderr)],
          { concurrency: 3 },
        );
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new MountError({
            message: `failed to run tigrisfs (is it installed in the image?)`,
            cause,
          }),
      ),
    );
    if (exitCode !== 0) {
      return yield* Effect.fail(
        new MountError({
          message: `tigrisfs exited with code ${exitCode} mounting ${config.bucket} at ${config.path}: ${
            stderr.trim() || stdout.trim()
          }`,
        }),
      );
    }

    const mounted = yield* isMounted(fs, config.path).pipe(
      Effect.repeat({
        schedule: Schedule.spaced(`${POLL_INTERVAL_MS} millis`),
        until: (ready) => ready,
        times: Math.ceil(config.readyTimeout / POLL_INTERVAL_MS),
      }),
    );
    if (!mounted) {
      return yield* Effect.fail(
        new MountError({
          message: `tigrisfs reported success but ${config.path} never appeared in /proc/mounts within ${config.readyTimeout}ms`,
        }),
      );
    }
  });

/**
 * The tigrisfs system dependencies as a `Docker.Host` image fragment:
 * `fuse3` for the mount plumbing and the `tigrisfs` adapter, fetched
 * for the image's target architecture — the same fragment serves the
 * amd64 deploy image and a native-arch dev image, on any
 * image-generating platform. `fuse3` comes from whichever package
 * manager the base carries (`apt-get` on Debian-family bases like
 * `oven/bun`; `dnf` on Amazon Linux — the AWS MicroVM base); tigrisfs
 * itself installs from the release tarball, package-manager free.
 */
const TIGRISFS_VERSION = "1.2.1";
const tigrisfsInstall = ({ arch }: Host.ImageTarget): string =>
  [
    `RUN if command -v apt-get >/dev/null; then \\`,
    `    apt-get update && apt-get install -y --no-install-recommends ca-certificates curl fuse3 && rm -rf /var/lib/apt/lists/*; \\`,
    `  else \\`,
    `    dnf install -y ca-certificates curl fuse3 tar gzip && dnf clean all; \\`,
    `  fi \\`,
    `  && curl -fsSL "https://github.com/tigrisdata/tigrisfs/releases/download/v${TIGRISFS_VERSION}/tigrisfs_${TIGRISFS_VERSION}_linux_${arch}.tar.gz" \\`,
    `    -o /tmp/tigrisfs.tar.gz \\`,
    `  && tar -xzf /tmp/tigrisfs.tar.gz -C /usr/local/bin \\`,
    `  && chmod +x /usr/local/bin/tigrisfs \\`,
    `  && rm /tmp/tigrisfs.tar.gz \\`,
    `  && echo "user_allow_other" >> /etc/fuse.conf`,
  ].join("\n");
