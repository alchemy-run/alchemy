/**
 * The Workspace — the PLACE the local tool physics work in: a
 * repository checkout, sandboxed. The entrypoint decides which
 * checkout (`workspace(root)`); tool implementations only ever
 * `yield* Workspace`. (Distinct from the `Coding` SKILL — the skill
 * is the craft, this is the place it is practiced.)
 *
 * TODO(workspace): the eventual default is a fresh temp CLONE of the
 * managed repository per run. Until then the operator points the
 * entrypoint at an existing checkout.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

export class Workspace extends Context.Service<
  Workspace,
  {
    /** Absolute path of the checkout root. */
    readonly root: string;
    /**
     * Resolve a workspace-relative path INSIDE the checkout; a path
     * that escapes fails model-visibly (the agent reacts, the loop
     * survives).
     */
    readonly resolve: (relative: string) => Effect.Effect<string, string>;
    /** Resolve an existing target and contain symlinks inside the root. */
    readonly resolveExisting: (
      relative: string,
    ) => Effect.Effect<string, string>;
    /**
     * Resolve a target that may not exist by containing its nearest
     * existing parent inside the root.
     */
    readonly resolveForCreate: (
      relative: string,
    ) => Effect.Effect<string, string>;
  }
>()("alchemy-org/Workspace") {}

/** The entrypoint's choice of checkout. */
export const workspace = (
  root: string,
): Layer.Layer<Workspace, never, Path.Path | FileSystem.FileSystem> =>
  Layer.effect(
    Workspace,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const canonicalRoot = yield* fs.realPath(path.resolve(root)).pipe(
        Effect.flatMap((resolved) =>
          fs
            .stat(resolved)
            .pipe(
              Effect.flatMap((info) =>
                info.type === "Directory"
                  ? Effect.succeed(resolved)
                  : Effect.fail(
                      new Error(`workspace root is not a directory: ${root}`),
                    ),
              ),
            ),
        ),
        Effect.orDie,
      );

      const validateRelative = (
        relative: string,
      ): Effect.Effect<string, string> => {
        if (relative.length === 0 || path.isAbsolute(relative)) {
          return Effect.fail(
            `path must be workspace-relative: ${JSON.stringify(relative)}`,
          );
        }
        const candidate = path.resolve(canonicalRoot, relative);
        const fromRoot = path.relative(canonicalRoot, candidate);
        return fromRoot === "" ||
          (!fromRoot.startsWith(`..${path.sep}`) &&
            fromRoot !== ".." &&
            !path.isAbsolute(fromRoot))
          ? Effect.succeed(candidate)
          : Effect.fail(
              `path escapes the workspace: ${JSON.stringify(relative)}`,
            );
      };

      const containCanonical = (
        relative: string,
        canonical: string,
      ): Effect.Effect<string, string> => {
        const fromRoot = path.relative(canonicalRoot, canonical);
        return fromRoot === "" ||
          (!fromRoot.startsWith(`..${path.sep}`) &&
            fromRoot !== ".." &&
            !path.isAbsolute(fromRoot))
          ? Effect.succeed(canonical)
          : Effect.fail(
              `path escapes the workspace through a symlink: ${JSON.stringify(relative)}`,
            );
      };

      const resolveExisting = (relative: string) =>
        Effect.gen(function* () {
          const candidate = yield* validateRelative(relative);
          const canonical = yield* fs
            .realPath(candidate)
            .pipe(Effect.mapError((error) => String(error)));
          return yield* containCanonical(relative, canonical);
        });

      const resolveForCreate = (relative: string) =>
        Effect.gen(function* () {
          const candidate = yield* validateRelative(relative);
          const existing = yield* fs.stat(candidate).pipe(Effect.result);
          if (Result.isSuccess(existing)) {
            return yield* resolveExisting(relative);
          }

          const missing: string[] = [];
          let parent = candidate;
          while (true) {
            const status = yield* fs.stat(parent).pipe(Effect.result);
            if (Result.isSuccess(status)) break;
            const next = path.dirname(parent);
            if (next === parent) {
              return yield* Effect.fail(
                `could not resolve a parent for ${JSON.stringify(relative)}`,
              );
            }
            missing.unshift(path.basename(parent));
            parent = next;
          }
          const canonicalParent = yield* fs
            .realPath(parent)
            .pipe(Effect.mapError((error) => String(error)));
          yield* containCanonical(relative, canonicalParent);
          return path.join(canonicalParent, ...missing);
        });

      return {
        root: canonicalRoot,
        resolve: resolveForCreate,
        resolveExisting,
        resolveForCreate,
      };
    }),
  );
