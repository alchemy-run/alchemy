import { Tool, ToolGroup } from "./Tool.ts";

/**
 * Run a shell command in the conversation's sandbox.
 *
 * The tag is only the name. Provide a coding agent's own tool
 * (`OpenCode.Bash`, `Pi.Bash`) or one of yours (`AI.Bash.make`).
 */
export class Bash extends Tool<Bash>()("bash") {}
/** Read a file. */
export class Read extends Tool<Read>()("read") {}
/** Replace text in a file. */
export class Edit extends Tool<Edit>()("edit") {}
/** Write a whole file. */
export class Write extends Tool<Write>()("write") {}
/** Search file contents. */
export class Grep extends Tool<Grep>()("grep") {}
/** Find files by pattern. */
export class Glob extends Tool<Glob>()("glob") {}

/**
 * The tools for working in a codebase: `bash`, `read`, `edit`, `write`,
 * `grep` and `glob`. Listing the group requires a Layer for each.
 *
 * **Example:** OpenCode's own coding tools
 * ```typescript
 * const harness = yield* OpenCode.Harness({ models: [Fast], tools: [AI.CodingTools] });
 * // provided with OpenCode.CodingTools
 * ```
 */
export const CodingTools = ToolGroup(Bash, Read, Edit, Write, Grep, Glob);
