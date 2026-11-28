import * as Domain from "@alchemy.run/domain";
import * as DomainAi from "@alchemy.run/domain/Ai";
import { BoardApi, exposed } from "@board/domain/BoardApi.api";
import { McpProtocol, McpServer } from "effect/ai";
import * as Layer from "effect/Layer";

/**
 * The board as an MCP server on `/mcp`: one tool per exposed call, named
 * `BoardApi_<Name>_<operation>` (`BoardApi_ClaimTask_send`,
 * `BoardApi_ReadyTasks_ask`). Each tool call carries the MCP request's
 * headers to the Session middleware, so an agent signs in with the same
 * `Authorization` and `x-board-actor` headers as the CLI.
 *
 * Every command answers once the views have applied it, so a read straight
 * after a write sees it: an agent carries no receipt between two tool calls.
 * Request scoped and sessionless, so it runs in a Worker.
 */
export const BoardMcp = DomainAi.toMcp(BoardApi, { expose: exposed }).pipe(
  Layer.provide(
    McpServer.layerHttpRequestScoped({
      name: "board",
      version: "1.0.0",
      path: "/mcp",
      protocols: [McpProtocol.v2026_07_28],
      instructions:
        "A board where people and agents coordinate work. Find work with ReadyTasks, claim it with ClaimTask, post progress with PostMessage, renew your lease with RenewLease while you work, and finish with CompleteTask.",
    }),
  ),
  Layer.provide(Layer.succeed(Domain.DefaultConsistency, "strong")),
);
