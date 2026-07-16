/**
 * The Reporter is an Effect service the runner emits structured events into.
 * Two implementations ship with the CLI: a plain line-oriented reporter for
 * non-interactive terminals / CI, and an opentui TUI for interactive use.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { LogEntry } from "./Model.ts";

export type TestStatus = "pass" | "fail" | "skip" | "todo";

export interface TestMeta {
  /** Stable id: `<file> > <describe chain> > <name>`. */
  readonly id: string;
  readonly file: string;
  readonly titlePath: ReadonlyArray<string>;
  readonly name: string;
}

export interface TestResult {
  readonly status: TestStatus;
  readonly durationMs: number;
  /** Pretty-printed failure (message + relevant stack), if failed. */
  readonly error?: string | undefined;
  /** Buffered Effect log / Console output captured during the test. */
  readonly logs: ReadonlyArray<LogEntry>;
  /** Number of retries that were attempted before this result. */
  readonly retries: number;
}

export interface RunSummary {
  readonly files: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly todo: number;
  readonly durationMs: number;
  readonly failures: ReadonlyArray<{ meta: TestMeta; result: TestResult }>;
}

export type TestEvent =
  | { readonly _tag: "CollectStart"; readonly files: ReadonlyArray<string> }
  | {
      /** Import progress: one per file during the collection phase. */
      readonly _tag: "FileCollected";
      readonly file: string;
    }
  | {
      /**
       * Collection is complete; execution is about to begin. Carries the
       * full (filtered) test list for the whole run.
       */
      readonly _tag: "RunStart";
      readonly files: number;
      readonly tests: ReadonlyArray<TestMeta>;
    }
  | { readonly _tag: "FileStart"; readonly file: string }
  | {
      readonly _tag: "FileEnd";
      readonly file: string;
      /** Buffered output of file-level hooks (deploy/destroy). */
      readonly logs: ReadonlyArray<LogEntry>;
      readonly error?: string | undefined;
    }
  | { readonly _tag: "TestStart"; readonly test: TestMeta }
  | {
      readonly _tag: "TestEnd";
      readonly test: TestMeta;
      readonly result: TestResult;
    }
  | { readonly _tag: "RunEnd"; readonly summary: RunSummary };

export interface ReporterService {
  readonly emit: (event: TestEvent) => Effect.Effect<void>;
  /**
   * Runs after RunEnd. The plain reporter returns immediately; the TUI blocks
   * until the user quits so results can be inspected.
   */
  readonly waitForExit: (summary: RunSummary) => Effect.Effect<void>;
}

export class Reporter extends Context.Service<Reporter, ReporterService>()(
  "alchemy-test/Reporter",
) {}
