import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as AiTool from "effect/unstable/ai/Tool";

/**
 * One granted capability, as the wire sees it: name, teaching, JSON
 * schemas for input and RETURN (from the Tool's `returns` schema —
 * `AI.Tool("readDiff", S.String)`), and the live handler.
 */
export interface ToolGrant {
  readonly name: string;
  readonly description: string;
  /** JSON schema of the tool's input object. */
  readonly parameters: unknown;
  /** JSON schema of the tool's return value (`unknown` when undeclared). */
  readonly returns: unknown;
  readonly handler: (input: any) => Effect.Effect<any, any>;
}

/** The transformed wire surface: provider tools + their handlers. */
export interface ToolPresentation {
  readonly tools: ReadonlyArray<AiTool.Any>;
  readonly handlers: Record<string, (input: any) => Effect.Effect<any, any>>;
}

export interface ToolEngineService {
  /** Present this tick's grants — called at every sampling boundary. */
  readonly present: (
    grants: ReadonlyArray<ToolGrant>,
  ) => Effect.Effect<ToolPresentation>;
}

/**
 * The TOOL ENGINE: how a tick's granted capabilities are presented to
 * the model and how its invocations execute. Mention-is-presence
 * stays the semantics either way — the stance decides WHAT exists
 * this tick; the engine decides how those grants appear on the wire.
 *
 * Absent (the default): direct tool-calling — every grant is its own
 * provider tool. Present (an optional service the driver resolves
 * from the interpret context): the engine transforms the grants —
 * CODEMODE collapses them into one `eval` tool whose description
 * carries generated type signatures, and whose handler evaluates the
 * model's code against the SAME granted handlers (the bridge is the
 * enforcement point: only this tick's grants exist inside the code).
 *
 * Driver intrinsics (`dispatch`, `spawn`, `skill`) stay direct tools —
 * they are conversation control, not capabilities.
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
