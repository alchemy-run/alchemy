import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as AiTool from "effect/unstable/ai/Tool";

/**
 * One MENTIONED tool, resolved for the wire: the stance's splice bound
 * to its teaching, JSON schemas for input and RETURN (from the Tool's
 * `returns` schema — `AI.Tool("readDiff", S.String)`), its declared
 * failures, and the live handler. A tool appears here iff this tick's
 * stance mentioned it — the array {@link ToolEngineService.present}
 * receives is mention-is-presence, materialized.
 */
export interface ToolMention {
  readonly name: string;
  readonly description: string;
  /** JSON schema of the tool's input object. */
  readonly parameters: unknown;
  /** JSON schema of the tool's return value (`unknown` when undeclared). */
  readonly returns: unknown;
  /**
   * The tool's DECLARED failures — the error classes its template
   * spliced (error mention-is-presence). `fields` is the error's JSON
   * schema when it is a `Schema.TaggedError`; a `Data.TaggedError`
   * contributes its tag alone. Anything not listed here is a DEFECT,
   * not a failure the program can catch.
   */
  readonly errors: ReadonlyArray<{
    readonly tag: string;
    readonly fields?: unknown;
  }>;
  /**
   * The compiled provider tool — an engine that keeps DIRECT
   * presentation (a policy wrapper around handlers, not a transport
   * change) passes it through instead of reconstructing it from the
   * JSON schemas.
   */
  readonly tool: AiTool.Any;
  readonly handler: (input: any) => Effect.Effect<any, any>;
}

/** The transformed wire surface: provider tools + their handlers. */
export interface ToolPresentation {
  readonly tools: ReadonlyArray<AiTool.Any>;
  readonly handlers: Record<string, (input: any) => Effect.Effect<any, any>>;
}

export interface ToolEngineService {
  /** Present this tick's mentions — called at every sampling boundary. */
  readonly present: (
    mentions: ReadonlyArray<ToolMention>,
  ) => Effect.Effect<ToolPresentation>;
}

/**
 * The TOOL ENGINE: how a tick's mentioned capabilities are presented
 * to the model and how its invocations execute. Mention-is-presence
 * stays the semantics either way — the stance decides WHAT exists
 * this tick; the engine decides how those mentions appear on the wire.
 *
 * Absent (the default): direct tool-calling — every mention is its own
 * provider tool. Present (an optional service the driver resolves
 * from the interpret context): the engine transforms the mentions —
 * CODEMODE collapses them into one `eval` tool whose description
 * carries generated type signatures, and whose handler evaluates the
 * model's code against the SAME mentioned handlers (the bridge is the
 * enforcement point: only this tick's mentions exist inside the code).
 *
 * Driver intrinsics (`dispatch`, `spawn`, `skill`) stay direct tools —
 * they are conversation control, not capabilities.
 *
 * PAYLOAD STABILITY: the driver's own direct path (no engine) carries
 * the session's union of every tool mentioned so far, so phase flips
 * never churn the provider payload (KV-cache prefix); an engine owns
 * that policy itself — a direct-presentation wrapper can mirror it,
 * codemode's single `eval` tool is stable by construction.
 *
 * ```ts
 * // swap the engine without touching a single charter:
 * IssuesLive.pipe(Layer.provide(AI.CodeModeEffect()))   // Effect programs
 * IssuesLive.pipe(Layer.provide(AI.CodeModeAsync()))    // async/await
 * // provide neither: direct tool-calling, exactly as before
 * ```
 */
export class ToolEngine extends Context.Service<
  ToolEngine,
  ToolEngineService
>()("alchemy/AI/ToolEngine") {}
