import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Output from "../Output.ts";
import { RuntimeContext, sanitizeKey } from "../RuntimeContext.ts";

/**
 * Where a term is DEFINED — the source file of an `AI.Agent`, `AI.Skill`,
 * or `AI.Tool`, captured by passing `import.meta` to the term's
 * constructor:
 *
 * ```ts
 * export class Harness extends AI.Skill<Harness>(import.meta)("Harness") {}
 * export class Engineer extends AI.Agent<Engineer>(import.meta)("Engineer") {}
 * ```
 *
 * The term then carries `Engineer.source`, and splicing THAT into prose
 * renders the file's path (in backticks) — a reference that follows the
 * file when it moves, because `import.meta.url` does:
 *
 * ```ts
 * Harness.make`
 *   ${Engineer.source} is the coding agent's charter; …`
 * ```
 *
 * Splicing the source grants nothing — `${Engineer}` (the term) is a
 * delegation, `${Engineer.source}` (its file) is a mention of a path.
 *
 * PLAN-TIME TRUTH, RUNTIME READ. `import.meta.url` names the real file
 * only in the process that runs the source — the plan (`alchemy deploy`,
 * a doc generator, a test). Inside a bundled Worker every module's
 * `import.meta.url` collapses to the bundle's own. So the path is
 * RESOLVED where it is true and BOUND for where it is not: a skill Layer
 * that splices a source `yield*`s {@link bindSource} while it is built,
 * which at plan time resolves the path over the plan's `FileSystem` and
 * stores it in the runtime's env (`RuntimeContext.set`, keyed by the
 * term), and at runtime reads it back (`RuntimeContext.get`) — the same
 * Output/Accessor round trip every binding takes. A process with neither
 * (a doc script, a unit test) resolves with {@link resolveSources}.
 *
 * The rendered path is relative to the nearest enclosing `package.json`
 * — the package the file belongs to, which is how its own docs name it
 * (`src/Harness.ts`, `src/coding/Engineer.ts`).
 */
export interface Source {
  readonly "~alchemy/Kind": "Source";
  /** `Kind/Name` of the owning term — the stable key the path is bound under. */
  readonly "~alchemy/Name": string;
  /** `import.meta.url` as seen by the process that constructed the term. */
  readonly url: string;
  /**
   * The path rendered into prose — set by {@link resolveSources} (plan,
   * over the FileSystem) or {@link bindSource} (runtime, from the env).
   * `undefined` until then; the term renders by name meanwhile.
   */
  path: string | undefined;
}

export const isSource = (value: unknown): value is Source =>
  typeof value === "object" &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "Source";

/** Build a term's {@link Source} from its `import.meta` (or a URL). */
export const makeSource = (
  meta: ImportMeta | string,
  kind: string,
  name: string,
): Source => ({
  "~alchemy/Kind": "Source",
  "~alchemy/Name": `${kind}/${name}`,
  url: typeof meta === "string" ? meta : meta.url,
  path: undefined,
});

/** The prose form: the path in backticks, or the term's name when the
 *  path is unknown. */
export const renderSource = (source: Source): string =>
  `\`${source.path ?? source["~alchemy/Name"]}\``;

/**
 * Resolve a source's path from its `file:` URL: relative to the nearest
 * enclosing `package.json` directory. Idempotent — a source already
 * resolved (or bound) is left alone. Not a `file:` URL (a bundle's
 * `import.meta.url`) resolves to nothing.
 */
export const resolveSource = (
  source: Source,
): Effect.Effect<
  string | undefined,
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    if (source.path !== undefined) return source.path;
    if (!source.url.startsWith("file:")) return undefined;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = yield* path
      .fromFileUrl(new URL(source.url))
      .pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (file === undefined) return undefined;
    let dir = path.dirname(file);
    for (;;) {
      const isRoot = yield* fs
        .exists(path.join(dir, "package.json"))
        .pipe(Effect.catch(() => Effect.succeed(false)));
      if (isRoot) {
        source.path = path.relative(dir, file);
        return source.path;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        source.path = path.basename(file);
        return source.path;
      }
      dir = parent;
    }
  });

/** {@link resolveSource} over every source among a template's splices. */
export const resolveSources = (
  refs: ReadonlyArray<unknown>,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.forEach(refs.filter(isSource), resolveSource, { discard: true });

/**
 * Bind a source's path across the plan → runtime boundary (see the
 * module doc). At plan time — where a `FileSystem` is present — the path
 * is resolved and stored under the term's key; at runtime the stored
 * value is read back and replaces whatever the bundle's `import.meta.url`
 * would have said. Both services are optional: without a
 * `RuntimeContext` nothing is stored, without a `FileSystem` nothing is
 * resolved, so the same Layer builds in a Worker, at plan, and in a test.
 */
export const bindSource = (source: Source): Effect.Effect<void> =>
  Effect.gen(function* () {
    const fs = yield* Effect.serviceOption(FileSystem.FileSystem);
    const path = yield* Effect.serviceOption(Path.Path);
    if (Option.isSome(fs) && Option.isSome(path)) {
      yield* resolveSource(source).pipe(
        Effect.provideService(FileSystem.FileSystem, fs.value),
        Effect.provideService(Path.Path, path.value),
      );
    }
    const ctx = yield* Effect.serviceOption(RuntimeContext);
    if (Option.isNone(ctx)) return;
    const key = yield* ctx.value.set(
      sanitizeKey(`alchemy_source_${source["~alchemy/Name"]}`),
      Output.literal(source.path ?? source["~alchemy/Name"]),
    );
    const bound = yield* ctx.value.get<string>(key);
    if (typeof bound === "string" && bound.length > 0) {
      source.path = bound;
    }
  });
