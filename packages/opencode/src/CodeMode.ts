import { CodeModeConvention } from "@alchemy.run/ai/CodeMode";
import * as Layer from "effect/Layer";
import { ENGINE } from "./Tool.ts";

/**
 * OpenCode's own code mode: its `execute` tool runs the programs, where
 * OpenCode runs, against OpenCode's declarations of the tools.
 * OpenCode decides how programs are written, so there is no convention or
 * `AI.Eval` to provide.
 *
 * It reaches every tool of yours and every MCP server's from programs, so
 * list them all inside `AI.CodeMode(...)`, the coding tools included.
 * OpenCode's own tools (`webfetch`) stay direct calls. A declared failure rejects with an
 * `Error` whose message is the failure's fields as JSON.
 *
 * **Example:** Your tools from programs
 * ```typescript
 * const HarnessLive = Layer.mergeAll(
 *   ModelsLive,
 *   AddLive,
 *   OpenCodeCloudflare.DurableObjectStorage,
 *   OpenCode.CodeModeNative,
 * );
 *
 * const harness = yield* OpenCode.Harness({
 *   models: [Fast],
 *   tools: [OpenCode.WebFetch, AI.CodeMode(Add)],
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
