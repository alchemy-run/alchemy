import { CodeModeConvention } from "@alchemy.run/ai/CodeMode";
import * as Layer from "effect/Layer";
import { ENGINE } from "./Tool.ts";

/**
 * OpenCode's own code mode: its `execute` tool runs the programs, inside
 * the session's sandbox, against OpenCode's declarations of the tools.
 * OpenCode decides how programs are written, so there is no convention or
 * `AI.Eval` to provide.
 *
 * It reaches every tool of yours and every MCP server's from programs, so
 * list them all inside `AI.CodeMode(...)`. OpenCode's own tools (shell,
 * read, edit) stay direct calls. A declared failure rejects with an
 * `Error` whose message is the failure's fields as JSON.
 *
 * **Example:** Your tools from programs, files and shell directly
 * ```typescript
 * const HarnessLive = Layer.mergeAll(ModelsLive, AddLive, OpenCode.CodingTools, OpenCode.CodeModeNative);
 *
 * const harness = yield* OpenCode.Harness({
 *   models: [Fast],
 *   tools: [AI.CodingTools, AI.CodeMode(Add)],
 * });
 * ```
 *
 * @layer
 * @provides AI.CodeModeConvention
 */
export const CodeModeNative: Layer.Layer<CodeModeConvention> = Layer.succeed(CodeModeConvention, {
  kind: "native",
  engine: ENGINE,
});
