import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as ServiceMap from "effect/ServiceMap";

export class Bundler extends ServiceMap.Service<
  Bundler,
  {
    build(options: BundleOptions): Effect.Effect<BundleOutput, BundleError>;
    watch(
      options: BundleOptions,
    ): Effect.Effect<
      { queue: Queue.Queue<WatchOutput> },
      BundleError,
      Scope.Scope
    >;
  }
>()("Bundler") {}

export interface BundleOptions {
  readonly entry?: string | string[] | Record<string, string>;
  readonly stdin?: StdinOptions;
  readonly outdir?: string;
  readonly outfile?: string;
  readonly format?: "esm" | "cjs" | "iife";
  readonly minify?: boolean;
  readonly sourcemap?: boolean | "inline" | "external";
  readonly external?: string[];
  readonly platform?: "node" | "browser" | "neutral";
  readonly target?: string;
  readonly define?: Record<string, string>;
  readonly splitting?: boolean;
  readonly treeshake?: boolean;
}

export interface StdinOptions {
  readonly contents: string;
  readonly resolveDir?: string;
  readonly sourcefile?: string;
  readonly loader?: "ts" | "tsx" | "js" | "jsx" | "json" | "css" | "text";
}

export interface BundleOutput {
  readonly outputs: BundleOutputFile[];
  readonly duration?: number;
}

export interface BundleOutputFile {
  readonly path: string;
  readonly code?: string;
  readonly map?: string;
  readonly size: number;
}

export interface WatchOutput {
  readonly outputs: BundleOutputFile[];
  readonly duration?: number;
}

export class BundleError extends Data.TaggedError("BundleError")<{
  readonly message: string;
  readonly errors: ReadonlyArray<BundleErrorDetail>;
  readonly cause?: unknown;
}> {}

export interface BundleErrorDetail {
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
}
