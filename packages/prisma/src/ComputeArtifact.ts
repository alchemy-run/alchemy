import { dotAlchemyDirectory } from "alchemy/AlchemyContext";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { ComputeBuild, ComputeBundleOptions } from "./Compute.ts";
import { storeArtifact } from "./internal/ArtifactStore.ts";
import {
  buildComputeArtifactFile,
  computeArtifactInputsHash,
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
}

export interface ComputeArtifact extends Resource<
  "Prisma.ComputeArtifact",
  ComputeArtifactProps,
  {
    /**
     * Path of the `tar.gz` artifact, named by its SHA-256 and kept under
     * `.alchemy` until the resource is deleted. Pass it to
     * `Prisma.ComputeVersion`'s `artifactPath`.
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
 * are hashed on every plan, the way `Command.Build` hashes its sources: every
 * file in the build directory that git does not ignore, the nearest lockfile,
 * and the build props. Without a build, every file the archive would contain
 * is hashed. When nothing changed, the build is skipped and `artifactPath`
 * stays the same, so the version that uses it is not replaced.
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
        diff: Effect.fn(function* ({ news, output }) {
          if (!output || !isResolved(news)) return undefined;
          if (!(yield* fs.exists(output.artifactPath))) return { action: "update" } as const;
          const inputHash = yield* computeArtifactInputsHash(news);
          return inputHash === output.inputHash
            ? ({ action: "noop" } as const)
            : ({ action: "update" } as const);
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const before = yield* computeArtifactInputsHash(news);
          if (output?.inputHash === before && (yield* fs.exists(output.artifactPath))) {
            return output;
          }
          const directory = yield* directoryOf(id);
          const artifact = yield* buildComputeArtifactFile(news, {
            effectNative: news.main !== undefined,
          });
          const artifactPath = yield* storeArtifact(directory, artifact.file).pipe(
            Effect.ensuring(artifact.file.cleanup),
          );
          // Hashed after the build, as `Command.Build` does, so files the
          // build writes into its own directory are part of the baseline.
          const inputHash = yield* computeArtifactInputsHash(news);
          return {
            artifactPath,
            hash: artifact.file.sha256,
            inputHash,
            defaultPort: artifact.port,
          };
        }),
        delete: Effect.fn(function* ({ id }) {
          const directory = yield* directoryOf(id);
          yield* fs.remove(directory, { recursive: true, force: true });
        }),
      };
    }),
  );
