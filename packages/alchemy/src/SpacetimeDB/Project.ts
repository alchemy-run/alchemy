import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { ClearDataMode } from "./Cli.ts";
import type { Providers } from "./Providers.ts";

/**
 * One database target in a multi-database {@link Project} (mirrors a
 * `children[]` entry in `spacetime.json`).
 *
 * @see https://spacetimedb.com/docs/cli-reference/spacetime-json
 */
export interface ProjectChild {
  /**
   * Database name (required). Must match `/^[a-z0-9]+(-[a-z0-9]+)*$/`.
   */
  database: string;
  /**
   * Override module source for this child. If set, parent `modulePath` /
   * `binPath` / `jsPath` are not inherited (source-conflict rule).
   */
  modulePath?: string;
  binPath?: string;
  jsPath?: string;
  /**
   * Override server for this child.
   */
  server?: string;
  /**
   * Per-child generate targets.
   */
  generate?: ReadonlyArray<ProjectGenerateTarget>;
}

export interface ProjectGenerateTarget {
  language: "typescript" | "csharp" | "rust" | "unrealcpp" | (string & {});
  outDir: string;
  namespace?: string;
  includePrivate?: boolean;
}

export interface ProjectProps {
  /**
   * Root database name (required by spacetime.json).
   */
  database: string;

  /**
   * Path to write `spacetime.json` (and optionally `spacetime.local.json`).
   * Defaults to the stack cwd.
   *
   * @default "."
   */
  configDir?: string;

  /**
   * Module source for the root database (and inherited by children unless
   * overridden).
   */
  modulePath?: string;
  binPath?: string;
  jsPath?: string;

  /**
   * Server nickname/URL for all databases unless a child overrides it.
   *
   * @default "maincloud"
   */
  server?: string;

  /**
   * Client `dev.run` command written into spacetime.json `dev` block.
   * Used by `spacetime dev` when not driven by Alchemy.
   */
  devRun?: string;

  /**
   * Root-level generate targets.
   */
  generate?: ReadonlyArray<ProjectGenerateTarget>;

  /**
   * Additional database targets (spacetime.json `children`).
   */
  children?: ReadonlyArray<ProjectChild>;

  /**
   * Also write `spacetime.local.json` with a stage-local database name
   * override so developers don't collide on shared names.
   *
   * @default true
   */
  writeLocalOverride?: boolean;

  /**
   * Local database name written to `spacetime.local.json` when
   * `writeLocalOverride` is true. Defaults to `${database}-local`.
   */
  localDatabase?: string;

  /**
   * Default clear-data policy documented in the generated config (informational).
   */
  clearData?: ClearDataMode;
}

export interface ProjectAttributes {
  /** Absolute path to the written spacetime.json. */
  configPath: string;
  /** Absolute path to spacetime.local.json if written. */
  localConfigPath: string | undefined;
  /** Root database name. */
  database: string;
  /** All database names (root + children). */
  databases: string[];
  /** Content hash of the written spacetime.json. */
  configHash: string;
}

export type Project = Resource<
  "SpacetimeDB.Project",
  ProjectProps,
  ProjectAttributes,
  never,
  Providers
>;

/**
 * Materialize a `spacetime.json` multi-database project config on disk.
 *
 * This is the Alchemy counterpart of the CLI's config-driven multi-target
 * workflow: one root database plus optional `children`, shared module path,
 * and generate targets. Pair each database name with a
 * {@link Database} resource (or rely on `spacetime publish` / local dev
 * reading this file).
 *
 * @resource
 * @see https://spacetimedb.com/docs/cli-reference/spacetime-json
 *
 * @section Multi-database project
 * @example World shards sharing one module
 * ```typescript
 * yield* SpacetimeDB.Project("worlds", {
 *   database: "world-highlands",
 *   modulePath: "./world-module",
 *   server: "maincloud",
 *   generate: [
 *     { language: "typescript", outDir: "./client/src/bindings" },
 *   ],
 *   children: [
 *     { database: "world-midlands" },
 *     { database: "world-coastlands" },
 *   ],
 * });
 * ```
 */
export const Project = Resource<Project>("SpacetimeDB.Project");

export const ProjectProvider = () =>
  Provider.succeed(Project, {
    stables: ["configPath"],
    list: () => Effect.succeed([]),
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || !output) return undefined;
      const next = yield* renderConfig(news);
      if (next.hash !== output.configHash) {
        return { action: "update" } as const;
      }
      return { action: "noop" } as const;
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = path.resolve(
        yield* Effect.sync(() => process.cwd()),
        news.configDir ?? ".",
      );
      yield* fs.makeDirectory(dir, { recursive: true });

      const { json, hash, databases } = yield* renderConfig(news);
      const configPath = path.join(dir, "spacetime.json");
      yield* fs.writeFileString(configPath, json);

      let localConfigPath: string | undefined;
      if (news.writeLocalOverride !== false) {
        localConfigPath = path.join(dir, "spacetime.local.json");
        const localDb = news.localDatabase ?? `${news.database}-local`;
        yield* fs.writeFileString(
          localConfigPath,
          `${JSON.stringify({ database: localDb }, null, 2)}\n`,
        );
      }

      return {
        configPath,
        localConfigPath,
        database: news.database,
        databases,
        configHash: hash,
      } satisfies ProjectAttributes;
    }),
    delete: Effect.fn(function* ({ output }) {
      const fs = yield* FileSystem.FileSystem;
      // Only remove files we wrote; never delete a user-authored config
      // that drifted (hash mismatch is fine — still our path).
      yield* fs.remove(output.configPath).pipe(Effect.catch(() => Effect.void));
      if (output.localConfigPath) {
        yield* fs
          .remove(output.localConfigPath)
          .pipe(Effect.catch(() => Effect.void));
      }
    }),
  });

const renderConfig = (news: ProjectProps) =>
  Effect.gen(function* () {
    const root: Record<string, unknown> = {
      database: news.database,
    };
    if (news.modulePath) root["module-path"] = news.modulePath;
    if (news.binPath) root["bin-path"] = news.binPath;
    if (news.jsPath) root["js-path"] = news.jsPath;
    if (news.server) root.server = news.server;
    if (news.devRun) root.dev = { run: news.devRun };
    if (news.generate?.length) {
      root.generate = news.generate.map(toGenerateJson);
    }
    if (news.children?.length) {
      root.children = news.children.map((child) => {
        const c: Record<string, unknown> = { database: child.database };
        if (child.modulePath) c["module-path"] = child.modulePath;
        if (child.binPath) c["bin-path"] = child.binPath;
        if (child.jsPath) c["js-path"] = child.jsPath;
        if (child.server) c.server = child.server;
        if (child.generate?.length) {
          c.generate = child.generate.map(toGenerateJson);
        }
        return c;
      });
    }

    const json = `${JSON.stringify(root, null, 2)}\n`;
    const hash = yield* Effect.sync(() =>
      createHash("sha256").update(json).digest("hex"),
    );
    const databases = [
      news.database,
      ...(news.children?.map((c) => c.database) ?? []),
    ];
    return { json, hash, databases };
  });

const toGenerateJson = (g: ProjectGenerateTarget) => {
  const out: Record<string, unknown> = {
    language: g.language,
    "out-dir": g.outDir,
  };
  if (g.namespace) out.namespace = g.namespace;
  if (g.includePrivate) out["include-private"] = true;
  return out;
};
