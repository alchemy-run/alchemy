import * as Acp from "@distilled.cloud/acp";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { DriverSession, DriverSessionOptions, HarnessDriver } from "./HarnessEngine.ts";
import {
  emptyUsage,
  SessionError,
  type Answer,
  type Capabilities,
  type ContentBlock,
  type ToolCall,
  type ToolContent,
  type ToolKind,
  type TurnStatus,
} from "./Session.ts";

/** How to launch an ACP agent inside the sandbox. */
export interface AcpAgentOptions {
  /** Harness name reported to clients. @default the command name */
  readonly name?: string;
  /** The agent executable, e.g. `"opencode"`. */
  readonly command: string;
  /** Arguments that put it in ACP mode, e.g. `["acp"]`. */
  readonly args?: ReadonlyArray<string>;
  readonly env?: Record<string, string | undefined>;
  /** Default working directory for sessions. @default "/workspace" */
  readonly cwd?: string;
}

/** What a generic ACP agent supports (ACP v1: no native steering, no subagents). */
export const acpCapabilities: Capabilities = {
  steering: "interrupt-restart",
  queuedPrompts: false,
  fork: false,
  rollback: false,
  subagents: false,
  plans: true,
  reasoning: true,
};

const toolKind = (kind: string | null | undefined): ToolKind => {
  switch (kind) {
    case "read":
      return "read";
    case "edit":
    case "delete":
    case "move":
      return "edit";
    case "search":
      return "search";
    case "execute":
      return "shell";
    case "think":
      return "think";
    case "fetch":
      return "fetch";
    default:
      return "other";
  }
};

const stopStatus = (stopReason: string): TurnStatus => {
  switch (stopReason) {
    case "end_turn":
      return "completed";
    case "cancelled":
      return "interrupted";
    case "refusal":
      return "refused";
    case "max_tokens":
    case "max_turn_requests":
      return "max_tokens";
    default:
      return "completed";
  }
};

const toAcpBlock = (block: ContentBlock): Acp.ContentBlock =>
  (block.type === "text"
    ? { type: "text", text: block.text }
    : { type: "image", mimeType: block.mimeType, data: block.data }) as Acp.ContentBlock;

const blockText = (block: Acp.ContentBlock): string =>
  (block as { type: string; text?: string }).type === "text"
    ? ((block as { text?: string }).text ?? "")
    : "";

const toolContent = (
  content: ReadonlyArray<Acp.ToolCallContent> | null | undefined,
): ToolContent[] =>
  (content ?? []).flatMap((c): ToolContent[] => {
    const item = c as {
      type: string;
      content?: Acp.ContentBlock;
      path?: string;
      oldText?: string | null;
      newText?: string;
    };
    if (item.type === "content" && item.content)
      return [{ type: "text", text: blockText(item.content) }];
    if (item.type === "diff" && item.path !== undefined && item.newText !== undefined) {
      return [
        {
          type: "diff",
          path: item.path,
          newText: item.newText,
          ...(item.oldText ? { oldText: item.oldText } : {}),
        },
      ];
    }
    return [];
  });

interface Routed {
  readonly options: DriverSessionOptions;
  /** The turn currently running, and the assistant text it has produced. */
  turn: { readonly turnId: string; text: string } | undefined;
  readonly permissions: Map<string, Deferred.Deferred<Acp.RequestPermissionResponse>>;
  readonly startedTools: Set<string>;
}

/**
 * A {@link HarnessDriver} for any ACP agent: one agent process (spawned in
 * the harness scope) serves every session; `session/update` notifications and
 * permission callbacks are routed to their session by ACP session id.
 */
export const acpDriver = (
  agent: AcpAgentOptions,
): Effect.Effect<HarnessDriver, SessionError, ChildProcessSpawner | Scope.Scope> =>
  Effect.gen(function* () {
    const sessions = new Map<string, Routed>();
    let nextPermission = 0;

    const handlers: Acp.InboundHandlers = {
      sessionRequestPermission: (req) =>
        Effect.gen(function* () {
          const routed = sessions.get(req.sessionId);
          const options = req.options;
          const allow = options.find((o) => o.kind === "allow_once" || o.kind === "allow_always");
          if (!routed || routed.options.approvals === "auto") {
            return {
              outcome: allow
                ? { outcome: "selected", optionId: allow.optionId }
                : { outcome: "cancelled" },
            } as Acp.RequestPermissionResponse;
          }
          const requestId = `perm-${++nextPermission}`;
          const answer = yield* Deferred.make<Acp.RequestPermissionResponse>();
          routed.permissions.set(requestId, answer);
          yield* routed.options.emit({
            type: "permission.requested",
            requestId,
            tool: {
              kind: toolKind(req.toolCall.kind),
              title: req.toolCall.title ?? "tool call",
              ...(req.toolCall.rawInput !== undefined ? { input: req.toolCall.rawInput } : {}),
            },
            options: options.map((o) => ({
              id: o.optionId,
              name: o.name,
              kind: (["allow_once", "allow_always", "reject_once", "reject_always"].includes(o.kind)
                ? o.kind
                : "reject_once") as "allow_once",
            })),
          });
          return yield* Deferred.await(answer);
        }),
    };

    const connection = yield* Layer.build(
      Acp.layerChildProcess({
        command: agent.command,
        ...(agent.args ? { args: agent.args } : {}),
        ...(agent.env ? { env: agent.env } : {}),
        handlers,
      }),
    ).pipe(
      Effect.mapError(
        (e) => new SessionError({ message: `failed to start ${agent.command}: ${e.message}` }),
      ),
    );
    const run = <A, E>(effect: Effect.Effect<A, E, Acp.AcpConnection>) =>
      effect.pipe(
        Effect.provideContext(connection),
        Effect.mapError(
          (e) => new SessionError({ message: String((e as { message?: string }).message ?? e) }),
        ),
      );

    yield* run(
      Acp.initialize({
        protocolVersion: Acp.ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "alchemy", version: "2" },
      }),
    );

    // One subscription for the whole connection; route by ACP session id.
    yield* Acp.sessionUpdates.pipe(
      Stream.runForEach((note) => {
        const routed = sessions.get(note.sessionId);
        if (!routed) return Effect.void;
        const { emit } = routed.options;
        const turnId = routed.turn?.turnId ?? "turn";
        const u = note.update as { sessionUpdate: string } & Record<string, any>;
        switch (u.sessionUpdate) {
          case "agent_message_chunk": {
            const text = blockText(u.content);
            if (routed.turn) routed.turn.text += text;
            return emit({
              type: "message.delta",
              itemId: u.messageId ?? turnId,
              role: "assistant",
              text,
            });
          }
          case "agent_thought_chunk":
            return emit({
              type: "reasoning.delta",
              itemId: u.messageId ?? turnId,
              text: blockText(u.content),
            });
          case "tool_call":
          case "tool_call_update": {
            const id: string = u.toolCallId;
            const tool: ToolCall = {
              kind: toolKind(u.kind),
              title: u.title ?? "tool call",
              ...(u.name ? { name: u.name } : {}),
              ...(u.rawInput !== undefined ? { input: u.rawInput } : {}),
            };
            const start = routed.startedTools.has(id)
              ? Effect.void
              : Effect.andThen(
                  Effect.sync(() => routed.startedTools.add(id)),
                  emit({ type: "tool.started", itemId: id, tool }),
                );
            const done =
              u.status === "completed" || u.status === "failed"
                ? emit({
                    type: "tool.completed",
                    itemId: id,
                    status: u.status === "completed" ? "ok" : "error",
                    content: toolContent(u.content),
                  })
                : Effect.void;
            return Effect.andThen(start, done);
          }
          case "plan":
            return emit({
              type: "plan.updated",
              entries: (u.entries as Acp.PlanEntry[]).map((e) => ({
                content: e.content,
                status: (["pending", "in_progress", "completed"].includes(e.status)
                  ? e.status
                  : "pending") as "pending",
              })),
            });
          default:
            return Effect.void;
        }
      }),
      Effect.provideContext(connection),
      Effect.forkScoped,
    );

    const open = (options: DriverSessionOptions) =>
      Effect.gen(function* () {
        const sessionScope = yield* Scope.Scope;
        const { sessionId } = yield* run(Acp.sessionNew({ cwd: options.cwd, mcpServers: [] }));
        const routed: Routed = {
          options,
          turn: undefined,
          permissions: new Map(),
          startedTools: new Set(),
        };
        sessions.set(sessionId, routed);
        yield* Effect.addFinalizer(() => Effect.sync(() => sessions.delete(sessionId)));

        const session: DriverSession = {
          prompt: (turnId, prompt) =>
            Effect.gen(function* () {
              routed.turn = { turnId, text: "" };
              yield* options.emit({ type: "turn.started", turnId });
              // The prompt call resolves when the turn ends; run it in the
              // background so `prompt` returns once the turn has started.
              yield* run(Acp.sessionPrompt({ sessionId, prompt: prompt.map(toAcpBlock) })).pipe(
                Effect.matchEffect({
                  onSuccess: ({ stopReason }) =>
                    options.emit({
                      type: "turn.completed",
                      turnId,
                      result: {
                        turnId,
                        status: stopStatus(stopReason),
                        message: [{ type: "text", text: routed.turn?.text ?? "" }],
                        usage: emptyUsage,
                      },
                    }),
                  onFailure: (error) =>
                    options.emit({
                      type: "turn.completed",
                      turnId,
                      result: {
                        turnId,
                        status: "failed",
                        message: [],
                        usage: emptyUsage,
                        error: error.message,
                      },
                    }),
                }),
                Effect.forkIn(sessionScope),
              );
            }),
          interrupt: () => run(Acp.sessionCancel({ sessionId })),
          respond: (requestId: string, answer: Answer) =>
            Effect.gen(function* () {
              const pending = routed.permissions.get(requestId);
              if (!pending) {
                return yield* new SessionError({ message: `no pending request ${requestId}` });
              }
              routed.permissions.delete(requestId);
              yield* Deferred.succeed(
                pending,
                (answer.type === "permission"
                  ? { outcome: { outcome: "selected", optionId: answer.optionId } }
                  : { outcome: { outcome: "cancelled" } }) as Acp.RequestPermissionResponse,
              );
            }),
        };
        return session;
      });

    return {
      name: agent.name ?? agent.command,
      capabilities: acpCapabilities,
      defaultCwd: agent.cwd ?? "/workspace",
      open,
    } satisfies HarnessDriver;
  });
