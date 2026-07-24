/**
 * The Workspace — the PLACE the local tool physics work in, sandboxed.
 * Tool implementations only ever `yield* Workspace`; which place is a
 * Layer decision:
 *
 * - {@link workspace} (static): one fixed containment root — the
 *   factory desk shape, where every run works the same checkout.
 * - {@link runWorkspace} (per-run): the root IS the current run's
 *   `Git.Workspaces` checkout, derived from `AI.Thread` at CALL time —
 *   the Engineer shape. Tools physically cannot write outside the
 *   run's own worktree, so path discipline needs no prose.
 *
 * (Distinct from the `Coding` SKILL — the skill is the craft, this is
 * the place it is practiced.)
 */
import * as AI from "alchemy/AI";
import * as Git from "alchemy/Git";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

export class Workspace extends Context.Service<
  Workspace,
  {
    /**
     * Absolute path of the containment root — resolved per CALL (the
     * per-run layer derives it from the current thread's checkout).
     */
    readonly root: Effect.Effect<string, string>;
    /**
     * Resolve a workspace-relative path INSIDE the root; a path that
     * escapes fails model-visibly (the agent reacts, the loop
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

/** The containment resolvers over one canonical root. */
const makeContainment = (
  canonicalRoot: string,
  fs: FileSystem.FileSystem,
  path: Path.Path,
) => {
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
      : Effect.fail(`path escapes the workspace: ${JSON.stringify(relative)}`);
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

  return { resolveExisting, resolveForCreate };
};

/** The entrypoint's choice of a FIXED containment root. */
export const workspace = (
  root: string,
): Layer.Layer<Workspace, never, Path.Path | FileSystem.FileSystem> =>
  Layer.effect(
    Workspace,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      // self-provisioning: the root is created if missing (checkouts
      // land under it later — Git.Workspaces populates, we contain)
      const resolved = path.resolve(root);
      yield* fs
        .makeDirectory(resolved, { recursive: true })
        .pipe(Effect.orDie);
      const canonicalRoot = yield* fs.realPath(resolved).pipe(Effect.orDie);
      const containment = makeContainment(canonicalRoot, fs, path);

      return {
        root: Effect.succeed(canonicalRoot),
        resolve: containment.resolveForCreate,
        resolveExisting: containment.resolveExisting,
        resolveForCreate: containment.resolveForCreate,
      };
    }),
  );

/**
 * The PER-RUN containment root: the current thread's `Git.Workspaces`
 * checkout. Every resolution derives the root from `AI.Thread` at call
 * time (tool handlers run with the thread provided), so an agent's
 * tools are physically confined to its own worktree — concurrent runs
 * cannot see each other, and "which directory am I in" is not a fact
 * the model can get wrong.
 */
export const runWorkspace = (): Layer.Layer<
  Workspace,
  never,
  Path.Path | FileSystem.FileSystem | Git.Workspaces
> =>
  Layer.effect(
    Workspace,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const workspaces = yield* Git.Workspaces;

      // AI.Thread is a runtime fact the kernel provides to handlers;
      // the Workspace interface deliberately hides the requirement
      // (same doctrine as org tool handlers reading AI.Thread).
      const root = Effect.gen(function* () {
        const { key } = yield* AI.Thread;
        const found = yield* workspaces.get(key);
        if (Option.isNone(found)) {
          return yield* Effect.fail(
            `no checkout for run '${key}' — the charter acquires one in init`,
          );
        }
        return found.value.root;
      }) as unknown as Effect.Effect<string, string>;

      const within = <A>(
        use: (
          containment: ReturnType<typeof makeContainment>,
        ) => Effect.Effect<A, string>,
      ) =>
        Effect.flatMap(root, (canonicalRoot) =>
          use(makeContainment(canonicalRoot, fs, path)),
        );

      return {
        root,
        resolve: (relative) =>
          within((containment) => containment.resolveForCreate(relative)),
        resolveExisting: (relative) =>
          within((containment) => containment.resolveExisting(relative)),
        resolveForCreate: (relative) =>
          within((containment) => containment.resolveForCreate(relative)),
      };
    }),
  );
