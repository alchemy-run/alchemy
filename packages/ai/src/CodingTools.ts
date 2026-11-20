import { ToolGroup, ToolTag } from "./Tool.ts";

/**
 * Run a shell command in the conversation's sandbox.
 *
 * The tag is only the name. Provide a coding agent's own tool
 * (`OpenCode.BashLive`, `Pi.BashLive`) or one of yours (`AI.Bash.make`).
 */
export class Bash extends ToolTag<Bash>()("bash") {}
/** Read a file. */
export class Read extends ToolTag<Read>()("read") {}
/** Replace text in a file. */
export class Edit extends ToolTag<Edit>()("edit") {}
/** Write a whole file. */
export class Write extends ToolTag<Write>()("write") {}
/** Search file contents. */
export class Grep extends ToolTag<Grep>()("grep") {}
/** Find files by pattern. */
export class Glob extends ToolTag<Glob>()("glob") {}

/**
 * The tools for working in a codebase: `bash`, `read`, `edit`, `write`,
 * `grep` and `glob`. Listing the group requires a Layer for each.
 *
 * **Example:** OpenCode's own coding tools
 * ```typescript
 * const harness = yield* OpenCode.Harness({ models: [Fast], tools: [AI.CodingTools] });
 * // provided with OpenCode.CodingToolsLive
 * ```
 */
export const CodingTools = ToolGroup(Bash, Read, Edit, Write, Grep, Glob);
