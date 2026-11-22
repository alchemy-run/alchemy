import type { CodeModeConvention, CodeModeGroup } from "@alchemy.run/ai/CodeMode";
import type { AnyMcpServer, McpServerClass } from "@alchemy.run/ai/McpServer";
import {
  isToolGroup,
  type AnyTool as AiTool,
  type AnyToolTag,
  type InlineTool,
  type SandboxesFor,
  type ToolClass,
  type ToolGroup,
  type ToolTagClass,
} from "@alchemy.run/ai/Tool";

const OpenCodeToolTypeId = "~alchemy/OpenCode/Tool" as const;

/**
 * One of the tools only OpenCode has (`webfetch`, `subagent`, …), run by
 * OpenCode in the session's sandbox. The tools every coding agent has are
 * tool tags instead (`AI.Bash`), provided here by `OpenCode.CodingTools`.
 */
export interface BuiltinTool<Name extends string = string> {
  readonly [OpenCodeToolTypeId]: "builtin";
  readonly toolName: Name;
}

/** A tool that can be enabled on a session, by reference. */
export type ToolRef = AiTool | AnyToolTag | BuiltinTool;

/** Anything an OpenCode harness lists as a tool: an `AI.Tool`, a tool tag, one of OpenCode's own, or a group. */
export type AnyTool = ToolRef | ToolGroup<ReadonlyArray<ToolRef>>;

type OwnRequirements<T> =
  T extends ToolTagClass<infer Self, any>
    ? Self
    : T extends ToolClass<any, any, any, infer Requires>
      ? Requires
      : T extends InlineTool<any, any, infer Uses>
        ? SandboxesFor<Uses>
        : never;

/** What a harness lists as a tool: a tool, an MCP server, or a code mode group of them. */
export type Listed = AnyTool | AnyMcpServer | CodeModeGroup<ReadonlyArray<AnyTool | AnyMcpServer>>;

/** What a prompt enables: a tool, an MCP server, or a code mode group of them. */
export type Enabled = ToolRef | AnyMcpServer | CodeModeGroup<ReadonlyArray<AnyTool | AnyMcpServer>>;

/** What listing `T` in a harness's `tools` requires to be provided. */
export type ToolRequirements<T> =
  T extends CodeModeGroup<infer Inner>
    ? CodeModeConvention | ToolRequirements<Inner[number]>
    : T extends McpServerClass<infer Self, any>
      ? Self
      : T extends ToolGroup<infer Tools>
        ? OwnRequirements<Tools[number]>
        : OwnRequirements<T>;

export const isBuiltin = (tool: AnyTool | AnyMcpServer): tool is BuiltinTool =>
  OpenCodeToolTypeId in tool && tool[OpenCodeToolTypeId] === "builtin";

/** Every tool a list names, groups flattened. */
export const flattenTools = (tools: ReadonlyArray<AnyTool>): ReadonlyArray<ToolRef> =>
  tools.flatMap((tool) => (isToolGroup(tool) ? flattenTools(tool.tools as never) : [tool]));

/** The engine name OpenCode's own tools are provided under (`AI.Bash.native`). */
export const ENGINE = "opencode";

const builtin = <const Name extends string>(toolName: Name): BuiltinTool<Name> => ({
  [OpenCodeToolTypeId]: "builtin",
  toolName,
});

/** Fetch a URL. */
export const WebFetch = builtin("webfetch");
/** Search the web. */
export const WebSearch = builtin("websearch");
/** Hand part of the task to a subagent, in a session of its own. */
export const Subagent = builtin("subagent");
