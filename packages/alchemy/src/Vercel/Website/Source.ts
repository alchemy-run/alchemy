/**
 * The serializable source descriptor a `Vercel.Website.*` transformer sets
 * on `Vercel.Function` props (DESIGN §4.3 / §7.1), plus the resolver the
 * FunctionProvider uses to turn it into a {@link DeploymentArtifact}.
 *
 * The descriptor is plain JSON data — it persists in state (`olds`) and
 * participates in props identity, so a changed `hash` (the producing
 * build's content hash) flows through the engine's default props
 * comparison and forces an update without the provider re-walking the
 * tree.
 */
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { initialCwd } from "../../Util/Node.ts";
import type { DeploymentArtifact } from "../Deploy/Artifact.ts";
import {
  fromBuildOutputDir,
  fromStaticDir,
  type BuildOutputRoute,
} from "../Deploy/BuildOutput.ts";

/**
 * A built website source consumed by the Vercel deploy engine.
 *
 * - `kind: "static"` — `dir` is a directory of plain files; the engine
 *   wraps it in a static-only Build Output artifact (everything under
 *   `static/`, filesystem routing).
 * - `kind: "buildOutput"` — `dir` is a complete `.vercel/output` (Build
 *   Output v3) tree emitted by a framework's Vercel preset/adapter,
 *   passed through as-is.
 */
export interface FunctionSourceDescriptor {
  /** Which Build Output shape {@link dir} holds. */
  readonly kind: "static" | "buildOutput";
  /**
   * The built directory — relative to the initial working directory (the
   * `Command.Build` output convention) or absolute.
   */
  readonly dir: string;
  /**
   * Content hash of {@link dir} (a `Command.Build`'s output hash). Not
   * read by the engine directly — it participates in props identity so a
   * content change triggers an update even before the artifact is
   * re-hashed.
   */
  readonly hash?: string | undefined;
  /**
   * Extra route entries merged BEFORE the filesystem handler
   * (`kind: "static"` only — a `buildOutput` tree carries its own
   * `config.json`).
   */
  readonly routes?: BuildOutputRoute[];
}

/**
 * Resolve a {@link FunctionSourceDescriptor} to a
 * {@link DeploymentArtifact}. Used by the FunctionProvider's `diff` (code
 * identity) and `reconcile` (artifact assembly) — both paths hash the
 * actual tree, so the descriptor's `hash` is never load-bearing.
 */
export const artifactFromSource = (
  source: FunctionSourceDescriptor,
): Effect.Effect<
  DeploymentArtifact,
  PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const dir = path.isAbsolute(source.dir)
      ? source.dir
      : path.resolve(initialCwd, source.dir);
    return source.kind === "static"
      ? yield* fromStaticDir(dir, source.routes)
      : yield* fromBuildOutputDir(dir);
  });
