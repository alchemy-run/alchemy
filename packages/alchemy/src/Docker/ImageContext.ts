/**
 * Files a binding contributes to its host's image build context.
 *
 * An {@link ImageLayer} can carry {@link ImageContextSource}s: inline files,
 * a host directory, or a git repository. The host materializes them under
 * the build context before building, and the layer's instructions `COPY`
 * them into place. Each source reports a digest (content hash, directory
 * hash, resolved commit) so the image is rebuilt exactly when a mounted
 * source changes.
 *
 * Git sources are fetched on the deploying machine with credentials passed
 * per command (an `Authorization` header), so tokens never reach the build
 * context, the image, or the copied `.git/config`.
 */
import * as Crypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

/** HTTP Basic credentials for a git remote. */
export interface GitCredentials {
  readonly username: string;
  readonly password: Redacted.Redacted<string>;
}

/** A file written into the build context. */
export interface ContentSource {
  readonly kind: "content";
  /** Path inside the build context. */
  readonly target: string;
  readonly content: string;
}

/** A directory on the deploying machine, copied into the build context. */
export interface DirectorySource {
  readonly kind: "directory";
  readonly target: string;
  /** Absolute path on the deploying machine. */
  readonly source: string;
}

/** A git repository checked out into the build context (with its `.git`). */
export interface GitSource {
  readonly kind: "git";
  readonly target: string;
  /** Clone URL (credential-free). */
  readonly url: string;
  /** Branch, tag, or commit. @default the remote's default branch */
  readonly ref?: string;
  /** Shallow history depth. @default full history */
  readonly depth?: number;
  /** Credentials for the fetch; never written to disk. */
  readonly credentials?: GitCredentials;
}

export type ImageContextSource = ContentSource | DirectorySource | GitSource;

export class ImageContextError extends Schema.TaggedError<ImageContextError>()(
  "ImageContextError",
  { message: Schema.String },
) {}

const sha256 = (value: string | Uint8Array) =>
  Crypto.createHash("sha256").update(value).digest("hex");

/** A stable, filesystem-safe directory name for a context target. */
export const contextTarget = (key: string) => `mounts/${sha256(key).slice(0, 16)}`;

/**
 * Materialize every source under `context` and return a digest over all of
 * them (fold it into the image hash).
 */
export const materializeImageContext = (options: {
  readonly context: string;
  /** Cache directory for git fetches (reused across builds). */
  readonly cacheDir: string;
  readonly sources: ReadonlyArray<ImageContextSource>;
}): Effect.Effect<
  string,
  ImageContextError | PlatformError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const digests = yield* Effect.forEach(
      options.sources,
      (source) =>
        Effect.map(materialize(options.context, options.cacheDir, source), (digest) => [
          source.target,
          digest,
        ]),
      { concurrency: 4 },
    );
    return sha256(JSON.stringify(digests.sort(([a], [b]) => String(a).localeCompare(String(b)))));
  });

const materialize = (context: string, cacheDir: string, source: ImageContextSource) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = path.join(context, source.target);
    // Digest the SOURCE first and rewrite the target only when it changed:
    // every plan materializes, and rewriting an unchanged mount would race
    // an image build reading the same context.
    const marker = `${target}.digest`;
    const previous = yield* fs.readFileString(marker).pipe(Effect.orElseSucceed(() => ""));
    const replace = (
      digest: string,
      write: Effect.Effect<void, PlatformError | ImageContextError>,
    ) =>
      Effect.gen(function* () {
        if (digest === previous && (yield* fs.exists(target))) return digest;
        yield* fs.remove(target, { recursive: true, force: true });
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* write;
        yield* fs.writeFileString(marker, digest);
        return digest;
      });
    switch (source.kind) {
      case "content":
        return yield* replace(sha256(source.content), fs.writeFileString(target, source.content));
      case "directory": {
        if (!(yield* fs.exists(source.source))) {
          return yield* new ImageContextError({
            message: `mounted folder ${source.source} does not exist`,
          });
        }
        return yield* replace(yield* hashTree(source.source), fs.copy(source.source, target));
      }
      case "git":
        // Copy under the cache lock: another mount of the same repository
        // may check out a different ref next.
        return yield* checkoutGit(cacheDir, source, (cache, commit) =>
          replace(commit, fs.copy(cache, target)),
        );
    }
  });

/** Deterministic hash over a directory tree (paths + contents). */
const hashTree = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = (yield* fs.readDirectory(root, { recursive: true })).sort();
    const hash = Crypto.createHash("sha256");
    for (const entry of entries) {
      const full = path.join(root, entry);
      const info = yield* fs.stat(full);
      if (info.type !== "File") continue;
      hash.update(entry);
      hash.update(yield* fs.readFile(full));
    }
    return hash.digest("hex");
  });

/**
 * Fetch `source` into a reusable cache clone and check out the ref; `use`
 * runs with the checkout (and its commit sha) under the cache's lock.
 */
/** One lock per cache clone: mounts of the same repository share it. */
const cacheLocks = new Map<string, Semaphore.Semaphore>();
const cacheLock = (cache: string) => {
  let lock = cacheLocks.get(cache);
  if (!lock) {
    lock = Semaphore.makeUnsafe(1);
    cacheLocks.set(cache, lock);
  }
  return lock;
};

const checkoutGit = <A, E, R>(
  cacheDir: string,
  source: GitSource,
  use: (cache: string, commit: string) => Effect.Effect<A, E, R>,
) =>
  Effect.suspend(() => {
    const cache = `${cacheDir}/${sha256(source.url).slice(0, 16)}`;
    return cacheLock(cache).withPermits(1)(
      checkoutGitLocked(cache, source).pipe(Effect.flatMap(({ commit }) => use(cache, commit))),
    );
  });

const checkoutGitLocked = (cache: string, source: GitSource) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const auth = source.credentials
      ? [
          "-c",
          `http.extraHeader=Authorization: Basic ${Buffer.from(
            `${source.credentials.username}:${Redacted.value(source.credentials.password)}`,
          ).toString("base64")}`,
        ]
      : [];
    const depth = source.depth !== undefined ? [`--depth=${source.depth}`] : [];
    // Under the cache lock, any git lock file is left over from a crashed run.
    for (const lock of ["index.lock", "config.lock", "shallow.lock"]) {
      yield* fs.remove(path.join(cache, ".git", lock), { force: true });
    }
    if (!(yield* fs.exists(path.join(cache, ".git")))) {
      yield* fs.makeDirectory(cache, { recursive: true });
      yield* git(cache, ["init", "--quiet"]);
      yield* git(cache, ["remote", "add", "origin", source.url]);
    } else {
      yield* git(cache, ["remote", "set-url", "origin", source.url]);
    }
    // No ref: ask the remote for its default branch (attributes can lag
    // reality, e.g. an imported repository's real default).
    const requested =
      source.ref ??
      /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(
        yield* git(cache, [...auth, "ls-remote", "--symref", "origin", "HEAD"]),
      )?.[1] ??
      "HEAD";
    yield* git(cache, [...auth, "fetch", "--quiet", "--tags", ...depth, "origin", requested]);
    // A branch ref checks out as a local branch tracking origin, so agents
    // can commit and push from it; tags and commits check out detached.
    const branch =
      requested !== "HEAD" &&
      !/^[0-9a-f]{40}$/.test(requested) &&
      !requested.startsWith("refs/tags/")
        ? requested.replace(/^refs\/heads\//, "")
        : undefined;
    yield* git(
      cache,
      branch
        ? ["checkout", "--quiet", "--force", "-B", branch, "FETCH_HEAD"]
        : ["checkout", "--quiet", "--force", "--detach", "FETCH_HEAD"],
    );
    if (branch) {
      yield* git(cache, ["update-ref", `refs/remotes/origin/${branch}`, "FETCH_HEAD"]);
      yield* git(cache, ["branch", "--quiet", `--set-upstream-to=origin/${branch}`, branch]);
    }
    yield* git(cache, ["clean", "-fdxq"]);
    const commit = (yield* git(cache, ["rev-parse", "HEAD"])).trim();
    return { cache, commit };
  });

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("git", [...args], {
        cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        extendEnv: true,
        // Never prompt for credentials on the deploying machine.
        env: { GIT_TERMINAL_PROMPT: "0" },
      }),
    );
    const [exitCode, stdout, stderr] = yield* Effect.all(
      [
        child.exitCode,
        child.stdout.pipe(Stream.decodeText, Stream.mkString),
        child.stderr.pipe(Stream.decodeText, Stream.mkString),
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) {
      const shown = args
        .filter(
          (a, i) =>
            !a.startsWith("http.extraHeader") &&
            !(a === "-c" && args[i + 1]?.startsWith("http.extraHeader")),
        )
        .join(" ");
      return yield* new ImageContextError({
        message: `git ${shown} failed (${exitCode}): ${stderr.trim()}`,
      });
    }
    return stdout;
  }).pipe(
    Effect.scoped,
    Effect.catchTag("PlatformError", (e) =>
      Effect.fail(new ImageContextError({ message: `git: ${e.message}` })),
    ),
  );
