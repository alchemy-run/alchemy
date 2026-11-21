import type { JsonObject, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import type { McpClient } from "effect/ai";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { messageOf } from "./promise.ts";

/** A server's tool as the model names it: `mcp__<server>__<tool>`. */
export const mcpToolName = (server: string, tool: string): string => `mcp__${server}__${tool}`;

/** The extension a server's tools are installed in. */
export const mcpExtensionName = (server: string): string => `mcp__${server}`;

/**
 * One Pi tool per tool the server lists. A call's result reaches the model
 * as the server returned it; a failed call (the server's own error, or the
 * transport's) reaches it as an error result it can read and act on.
 */
export const mcpRegistrations = (
  server: string,
  client: McpClient.McpClient,
  run: <A, E>(
    effect: Effect.Effect<A, E>,
    signal: AbortSignal | undefined,
  ) => Promise<Exit.Exit<A, E>>,
) =>
  Effect.map(client.listTools(), (tools) =>
    tools.map(
      (tool) =>
        ({
          name: mcpToolName(server, tool.name),
          description: tool.description ?? tool.title ?? tool.name,
          parameters: tool.inputSchema as JsonObject,
          execute: async (args, _api, context): Promise<ToolExecutionResult> => {
            const exit = await run(
              client.callTool({ tool, arguments: args as Record<string, unknown> }),
              context.abortSignal,
            );
            if (Exit.isSuccess(exit)) {
              return {
                ...(exit.value.isError === true ? { isError: true } : {}),
                output: exit.value.content.map((block) => ({
                  type: "text" as const,
                  text: block.type === "text" ? block.text : JSON.stringify(block),
                })),
              };
            }
            const failure = exit.cause.reasons.find(Cause.isFailReason);
            if (failure !== undefined) {
              return {
                isError: true,
                output: [{ type: "text", text: `MCP server ${server}: ${failure.error.message}` }],
              };
            }
            // A defect or interruption: Pi turns a throw into the model's error result.
            throw new Error(messageOf(exit.cause.pipe(Cause.squash)));
          },
        }) as ToolRegistration,
    ),
  );
