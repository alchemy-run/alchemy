import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { generateViaCli } from "./Cli.ts";
import type { Providers } from "./Providers.ts";

export interface GenerateProps {
  /**
   * Client language for generated bindings.
   */
  lang: "typescript" | "csharp" | "rust" | "unrealcpp" | (string & {});

  /**
   * Output directory for generated client bindings (relative to cwd or absolute).
   */
  outDir: string;

  /**
   * Path to the module project (same as `Database.modulePath`). Mutually
   * exclusive with {@link binPath} / {@link jsPath}.
   */
  modulePath?: string;

  /**
   * Path to a compiled WASM module.
   */
  binPath?: string;

  /**
   * Path to a bundled JS module.
   */
  jsPath?: string;

  /**
   * Optional database name/identity to generate against a live schema
   * instead of a local module source.
   */
  database?: string;

  /**
   * Include private tables and functions in generated code.
   * @default false
   */
  includePrivate?: boolean;
}

export interface GenerateAttributes {
  /**
   * Language the bindings were generated for (`typescript`, `csharp`, etc.).
   */
  lang: string;
  /**
   * Output directory the bindings were written to.
   */
  outDir: string;
  /**
   * Resolved source module path (one of `modulePath` / `binPath` / `jsPath`).
   */
  modulePath: string | undefined;
  /**
   * Path to the compiled WASM module, when bindings were generated from a binary.
   */
  binPath: string | undefined;
  /**
   * Path to a bundled JS module, when bindings were generated from a JS build.
   */
  jsPath: string | undefined;
  /**
   * Live database name/identity the bindings were generated against, when
   * not generated from local source.
   */
  database: string | undefined;
  /**
   * Hash of the source module the bindings were generated from. Used by
   * {@link Database} / {@link Connect} so subsequent deploys can detect
   * stale client bindings.
   */
  moduleContentHash: string;
}

export type Generate = Resource<
  "SpacetimeDB.Generate",
  GenerateProps,
  GenerateAttributes,
  never,
  Providers
>;

/**
 * Generate SpacetimeDB client module bindings (`spacetime generate`).
 *
 * Runs at deploy time so your client (React, Unity, …) always has fresh
 * typed tables/reducers. Pair with {@link Database} that owns the same
 * `modulePath` / `binPath`.
 *
 * Requires the `spacetime` CLI on `PATH`.
 *
 * @resource
 * @see https://spacetimedb.com/docs/cli-reference#spacetime-generate
 *
 * @section Generating TypeScript bindings
 * @example Generate TypeScript bindings
 * ```typescript
 * yield* SpacetimeDB.Generate("client-bindings", {
 *   lang: "typescript",
 *   outDir: "./src/module_bindings",
 *   modulePath: "./spacetimedb",
 * });
 * ```
 */
export const Generate = Resource<Generate>("SpacetimeDB.Generate");

const SOURCE_EXTENSIONS = [".ts", ".rs", ".cs", ".cpp", ".toml", ".json"];

const hashModuleSource = (
  modulePath: string | undefined,
  binPath: string | undefined,
  jsPath: string | undefined,
  database: string | undefined,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = binPath ?? jsPath;
    if (target) {
      const resolved = path.isAbsolute(target)
        ? target
        : path.resolve(yield* Effect.sync(() => process.cwd()), target);
      return yield* fs.readFile(resolved).pipe(
        Effect.map((bytes) => sha256Bytes(bytes)),
        Effect.orElseSucceed(() => ""),
      );
    }
    if (!modulePath) return ""; // database-only (live) — no local content
    const root = path.resolve(
      yield* Effect.sync(() => process.cwd()),
      modulePath,
    );
    return yield* fs.stat(root).pipe(
      Effect.flatMap((stat) =>
        stat.type === "Directory"
          ? walkAndHash(fs, path, root)
          : fs.readFile(root).pipe(
              Effect.map(sha256Bytes),
              Effect.orElseSucceed(() => ""),
            ),
      ),
      Effect.orElseSucceed(() => ""),
    );
  });

const walkAndHash = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
): Effect.Effect<string, never, never> =>
  Effect.gen(function* () {
    const entries = yield* fs
      .readDirectory(root)
      .pipe(Effect.orElseSucceed(() => []));
    let acc = root;
    for (const entry of entries) {
      const full = path.join(root, entry);
      const stat = yield* fs.stat(full).pipe(Effect.orElseSucceed(() => null));
      if (!stat) continue;
      if (stat.type === "Directory") {
        if (
          entry === "node_modules" ||
          entry === "target" ||
          entry === "dist" ||
          entry === ".git"
        ) {
          continue;
        }
        acc += "|" + (yield* walkAndHash(fs, path, full));
      } else if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
        const content = yield* fs.readFile(full).pipe(
          Effect.map(sha256Bytes),
          Effect.orElseSucceed(() => ""),
        );
        acc += "|" + entry + ":" + content;
      }
    }
    return acc;
  });

const sha256Bytes = (bytes: Uint8Array): string => {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
};

export const GenerateProvider = () =>
  Provider.succeed(Generate, {
    list: () => Effect.succeed([]),
    diff: Effect.fn(function* ({ news, output }) {
      if (!output) return undefined;
      if (!isResolved(news)) return undefined;
      if (
        news.lang !== output.lang ||
        news.outDir !== output.outDir ||
        news.modulePath !== output.modulePath ||
        news.binPath !== output.binPath ||
        news.jsPath !== output.jsPath ||
        news.database !== output.database
      ) {
        return { action: "update" } as const;
      }
      return undefined;
    }),
    reconcile: Effect.fn(function* ({ news }) {
      if (!news.modulePath && !news.binPath && !news.jsPath && !news.database) {
        return yield* Effect.die(
          new Error(
            "SpacetimeDB.Generate requires one of modulePath, binPath, jsPath, or database",
          ),
        );
      }
      yield* generateViaCli({
        lang: news.lang,
        outDir: news.outDir,
        modulePath: news.modulePath,
        binPath: news.binPath,
        jsPath: news.jsPath,
        database: news.database,
        includePrivate: news.includePrivate,
      });
      const moduleContentHash = yield* hashModuleSource(
        news.modulePath,
        news.binPath,
        news.jsPath,
        news.database,
      );
      return {
        lang: news.lang,
        outDir: news.outDir,
        modulePath: news.modulePath,
        binPath: news.binPath,
        jsPath: news.jsPath,
        database: news.database,
        moduleContentHash,
      } satisfies GenerateAttributes;
    }),
    delete: () => Effect.void,
  });
