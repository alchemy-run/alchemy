import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";

/** Serializable options shared by host-provided Vite sources. */
export interface ViteSourceOptions {
  main?: string;
  rootDir?: string;
  memo?: {
    include?: string[];
    exclude?: string[];
    lockfile?: boolean;
    workspaces?:
      | "auto"
      | Array<{
          cwd: string;
          include?: string[];
          exclude?: string[];
          lockfile?: boolean;
        }>;
  };
}

/** Structural error contract, shared with the source loader. */
export class SourcePolicyError extends Data.TaggedError(
  "Cloudflare.Workers.SourceProviderError",
)<{
  readonly provider: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ViteSourcePolicy {
  /** Applied before asset hashing; explicit user configuration takes precedence. */
  readonly assetDefaults?: (build: {
    readonly clientDirectory: string | undefined;
    readonly serverDirectory: string | undefined;
  }) => Effect.Effect<
    | { notFoundHandling?: "none" | "single-page-application" | "404-page" }
    | undefined,
    SourcePolicyError | PlatformError,
    FileSystem.FileSystem | Path.Path
  >;
  /** Optional asset binding exposed to the development Worker. */
  readonly devAssetsBinding?: string;
}

/**
 * Host capabilities passed to source-module factories. Framework packages
 * can compose the host's Vite pipeline without depending on the IaC package.
 * The source type stays opaque: lifecycle services and errors belong to the host.
 */
export interface SourceHost<Source> {
  readonly vite: (
    options: ViteSourceOptions,
    policy: ViteSourcePolicy,
  ) => Source;
}
