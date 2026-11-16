import { dotAlchemyDirectory } from "alchemy/AlchemyContext";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { ComputeBuild, ComputeBundleOptions } from "./Compute.ts";
import { resolveStoredPath, storeArtifact } from "./internal/ArtifactStore.ts";
import {
  buildComputeArtifactFile,
  computeArtifactInputsHash,
  type ComputeArtifactMemo,
  effectNativeInputsHash,
} from "./internal/ComputeArtifactBuild.ts";

export interface ComputeArtifactProps {
  /**
   * Application directory. Without `build` or `main` it is archived as it is;
   * with a build it is where the build runs.
   *
   * @default "."
   */
  path?: string;
  /**
   * Files or directories to leave out of the archive. Static build patterns
   * are relative to the build's output directory; other patterns are
   * artifact-relative. `*` and `**` wildcards are supported. `.env*`, `.git`
   * and `.alchemy` are always left out.
   */
  archiveIgnore?: readonly string[];
  /**
   * Entrypoint relative to the archived directory. If omitted, Alchemy reads
   * `package.json#main`.
   */
  entrypoint?: string;
  /**
   * Entry module of an Effect-native app. When set, the module is bundled with
   * the Prisma Compute bootstrap instead of building or archiving `path`.
   */
  main?: string;
  /**
   * Exported symbol inside `main`.
   *
   * @default "default"
   */
  handler?: string;
  /**
   * Bundler options for an Effect-native `main`.
   */
  bundle?: ComputeBundleOptions;
  /**
   * Build to run before archiving: a command build, `"auto"` framework
   * detection, or a static build. Set to `false`, or leave unset, to archive
   * `path` as it is.
   */
  build?: ComputeBuild | false | "auto";
  /**
   * HTTP port the application listens on. Overrides the port a framework
   * build detects.
   *
   * @default 8080, or the port the auto or static build detects
   */
  port?: number;
  /**
   * Which files decide whether the artifact is built again, with the same
   * meaning as `Command.Build`'s `memo`. Applies to `path` and to command,
   * auto and static builds; an Effect-native `main` is always compared by its
   * bundle. Set `include` to cover a sibling workspace package or a file git
   * ignores that the build reads. Set to `false` to build on every deploy,
   * which also creates a new version on every deploy.
   *
   * @default for a build, every file under its working directory that git does not ignore, plus the nearest lockfile; for `path` alone, every file the archive contains
   */
  memo?: ComputeArtifactMemo;
}

export interface ComputeArtifact extends Resource<
  "Prisma.ComputeArtifact",
  ComputeArtifactProps,
  {
    /**
     * Path of the `tar.gz` artifact, relative to the working directory the
     * deploy started in. It is named by its SHA-256 and kept under `.alchemy`
     * until the resource is deleted. Pass it to `Prisma.ComputeVersion`'s
     * `artifactPath`.
     */
    artifactPath: string;
    /**
     * SHA-256 of the artifact.
     */
    hash: string;
    /**
     * SHA-256 of the inputs that produced the artifact: the source files and
     * the build props. An unchanged value means the build is skipped.
     */
    inputHash: string;
    /**
     * HTTP port the application listens on: `port`, or the port the build
     * detected.
     */
    defaultPort: number;
  }
> {}

/**
 * The build output of a Prisma Compute application, as a `tar.gz` artifact on
 * this machine. It makes no Prisma API calls; pass `artifactPath` to a
 * `Prisma.ComputeVersion` to upload it.
 *
 * The artifact is built from an Effect-native `main`, a command, `"auto"`
 * framework detection or a static build, or from `path` as it is. Its inputs
 * are hashed on every plan. When nothing changed, the build is skipped and
 * `artifactPath` stays the same, so the version that uses it is not replaced.
 * That holds on a machine that never built it, such as a CI runner: the
 * archive's name is its SHA-256, so `Prisma.ComputeVersion` knows the bytes
 * are unchanged without the file.
 *
 * What is hashed:
 * - an Effect-native `main`: the bundle, so every module it imports counts,
 *   in any package;
 * - `path` without a build: every file the archive would contain;
 * - a command, auto or static build: as `Command.Build` does, every file under
 *   the build's working directory that git does not ignore and the nearest
 *   lockfile, or the files `memo` selects;
 * - the props, with `build.env` resolved.
 *
 * The process environment is not hashed. A build that reads a variable not
 * passed in `build.env` is not rebuilt when that variable changes.
 *
 * ### Building an Artifact
 * **Example:** Build an app and serve it as the service's active version
 * ```typescript
 * const artifact = yield* Prisma.ComputeArtifact("web-artifact", {
 *   path: "./apps/web",
 *   build: { command: "bun run build", outdir: "dist", entrypoint: "server.js" },
 * });
 * const service = yield* Prisma.ComputeService("web", { project });
 * const version = yield* Prisma.ComputeVersion("web-version", {
 *   service: service.serviceId,
 *   artifactPath: artifact.artifactPath,
 *   artifactContentType: "application/gzip",
 *   portMapping: { http: artifact.defaultPort },
 * });
 * yield* Prisma.activateVersion(service, version);
 * ```
 *
 * **Example:** Archive a directory that is already built
 * ```typescript
 * const artifact = yield* Prisma.ComputeArtifact("api-artifact", {
 *   path: "./dist",
 *   entrypoint: "server.js",
 * });
 * ```
 *
 * **Example:** Detect the framework and build it
 * ```typescript
 * const artifact = yield* Prisma.ComputeArtifact("site-artifact", {
 *   path: "./apps/site",
 *   build: "auto",
 * });
 * ```
 *
 * @resource
 * @product Compute
 */
export const ComputeArtifact = Resource<ComputeArtifact>("Prisma.ComputeArtifact");

const memoOptions = (memo: ComputeArtifactMemo | undefined) =>
  typeof memo === "object" ? memo : undefined;

export const ComputeArtifactProvider = () =>
  Provider.effect(
    ComputeArtifact,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dotAlchemy = yield* dotAlchemyDirectory;
      const directoryOf = (id: string) =>
        createPhysicalName({ id, maxLength: 80 }).pipe(
          Effect.map((name) => path.join(dotAlchemy, "prisma-compute-artifacts", name)),
        );
      return {
        list: () => Effect.succeed([]),
        // Unchanged inputs are a noop even when the archive is not on this
        // machine: it is named by its SHA-256, so the version that uses it
        // needs no upload. A reconcile that runs for another reason rebuilds it.
        diff: Effect.fn(function* ({ news, output }) {
          if (!output || !isResolved(news)) return undefined;
          if (news.memo === false) return { action: "update" } as const;
          const inputHash = yield* computeArtifactInputsHash(news, memoOptions(news.memo));
          return inputHash === output.inputHash
            ? ({ action: "noop" } as const)
            : ({ action: "update" } as const);
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const memo = memoOptions(news.memo);
          const saved = news.memo === false ? undefined : output;
          if (saved) {
            const before = yield* computeArtifactInputsHash(news, memo);
            const stored = yield* resolveStoredPath(saved.artifactPath);
            if (saved.inputHash === before && (yield* fs.exists(stored))) return saved;
          }
          const directory = yield* directoryOf(id);
          const effectNative = news.main !== undefined;
          const artifact = yield* buildComputeArtifactFile(news, { effectNative });
          const artifactPath = yield* storeArtifact(directory, artifact.file).pipe(
            Effect.ensuring(artifact.file.cleanup),
          );
          // Hashed after the build, as `Command.Build` does, so files the
          // build writes into its own directory are part of the baseline.
          const inputHash =
            effectNative && artifact.bundleHash !== undefined
              ? yield* effectNativeInputsHash(news, artifact.bundleHash)
              : yield* computeArtifactInputsHash(news, memo);
          return {
            artifactPath,
            hash: artifact.file.sha256,
            inputHash,
            defaultPort: artifact.port,
          };
        }),
        delete: Effect.fn(function* ({ id }) {
          const directory = yield* resolveStoredPath(yield* directoryOf(id));
          yield* fs.remove(directory, { recursive: true, force: true });
        }),
      };
    }),
  );
