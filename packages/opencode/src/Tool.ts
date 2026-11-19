import type { AnyMcpServer, McpServerClass } from "@alchemy.run/ai/McpServer";
import type { Sandboxes } from "@alchemy.run/ai/Sandbox";
import type { AnyTool as AiTool, InlineTool, SandboxesFor, ToolClass } from "@alchemy.run/ai/Tool";

const OpenCodeToolTypeId = "~alchemy/OpenCode/Tool" as const;

/** One of OpenCode's own tools (`bash`, `read`, …), run by OpenCode in the session's sandbox. */
export interface BuiltinTool<Name extends string = string> {
  readonly [OpenCodeToolTypeId]: "builtin";
  readonly toolName: Name;
}

/** Several tools listed as one. */
export interface ToolGroup<Tools extends ReadonlyArray<AnyTool> = ReadonlyArray<AnyTool>> {
  readonly [OpenCodeToolTypeId]: "group";
  readonly tools: Tools;
}

/** Anything an OpenCode harness lists as a tool: an `AI.Tool`, one of OpenCode's own, or a group. */
export type AnyTool = AiTool | BuiltinTool | ToolGroup;

/** A tool that can be enabled on a session, by reference. */
export type ToolRef = AiTool | BuiltinTool;

type OwnRequirements<T> =
  T extends ToolClass<any, any, any, infer Requires>
    ? Requires
    : T extends InlineTool<any, any, infer Uses>
      ? SandboxesFor<Uses>
      : never;

/** What listing `T` in a harness's `tools` requires to be provided. */
export type ToolRequirements<T> =
  T extends McpServerClass<infer Self, any>
    ? Self
    : T extends ToolGroup<infer Tools>
      ? OwnRequirements<Tools[number]>
      : OwnRequirements<T>;

export const isBuiltin = (tool: AnyTool | AnyMcpServer): tool is BuiltinTool =>
  OpenCodeToolTypeId in tool && tool[OpenCodeToolTypeId] === "builtin";

const isGroup = (tool: AnyTool): tool is ToolGroup =>
  OpenCodeToolTypeId in tool && tool[OpenCodeToolTypeId] === "group";

/** Every tool a list names, groups flattened. */
export const flattenTools = (tools: ReadonlyArray<AnyTool>): ReadonlyArray<ToolRef> =>
  tools.flatMap((tool) => (isGroup(tool) ? flattenTools(tool.tools) : [tool]));

const builtin = <const Name extends string>(toolName: Name): BuiltinTool<Name> => ({
  [OpenCodeToolTypeId]: "builtin",
  toolName,
});

/** Run a shell command in the session's sandbox. */
export const Bash = builtin("bash");
/** Read a file. */
export const Read = builtin("read");
/** Replace text in a file. */
export const Edit = builtin("edit");
/** Write a file. */
export const Write = builtin("write");
/** Search file contents. */
export const Grep = builtin("grep");
/** Find files by pattern. */
export const Glob = builtin("glob");
/** Fetch a URL. */
export const WebFetch = builtin("webfetch");
/** Keep a todo list for the task. */
export const TodoWrite = builtin("todowrite");
/** Hand part of the task to a subagent. */
export const Task = builtin("task");

/** OpenCode's tools for working in a codebase: `bash`, `read`, `edit`, `write`, `grep`, `glob`. */
export const CodingTools: ToolGroup<
  readonly [typeof Bash, typeof Read, typeof Edit, typeof Write, typeof Grep, typeof Glob]
> = {
  [OpenCodeToolTypeId]: "group",
  tools: [Bash, Read, Edit, Write, Grep, Glob],
};
