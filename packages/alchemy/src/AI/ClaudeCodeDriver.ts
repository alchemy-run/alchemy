import type {
  CanUseTool,
  PermissionMode,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { DriverSession, DriverSessionOptions, HarnessDriver } from "./HarnessEngine.ts";
import {
  SessionError,
  type Answer,
  type Capabilities,
  type ContentBlock,
  type ToolKind,
  type TurnStatus,
  type Usage,
} from "./Session.ts";

/** The Agent SDK package (and the version server images install). */
export const CLAUDE_AGENT_SDK: string = "@anthropic-ai/claude-agent-sdk";
export const CLAUDE_AGENT_SDK_VERSION = "0.3.284";

export interface ClaudeCodeOptions {
  /**
   * Default permission mode for sessions. Sessions started with
   * `approvals: "ask"` use `default` and surface `permission.requested`.
   * @default "bypassPermissions"
   */
  readonly permissionMode?: PermissionMode;
  /** Default model (e.g. `claude-opus-5-5`). */
  readonly model?: string;
  /** Path to the `claude` binary. @default the SDK's bundled resolution */
  readonly executable?: string;
  /** Extra environment for the `claude` process (credentials, base URL). */
  readonly env?: Record<string, string | undefined>;
  /** Default working directory. @default "/workspace" */
  readonly cwd?: string;
  /**
   * Resolve a session's `account` to the environment its `claude` process
   * runs with (e.g. `{ CLAUDE_CODE_OAUTH_TOKEN }`). Returning `undefined`
   * rejects the account. Omit to ignore `account`.
   */
  readonly accountEnv?: (account: string | undefined) => Record<string, string> | undefined;
}

/** Claude Code natively steers mid-turn, forks sessions, and runs subagents. */
export const claudeCodeCapabilities: Capabilities = {
  steering: "native",
  queuedPrompts: true,
  fork: false,
  rollback: false,
  subagents: true,
  plans: true,
  reasoning: true,
};

const toolKind = (name: string): ToolKind => {
  switch (name) {
    case "Bash":
    case "BashOutput":
    case "KillShell":
      return "shell";
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return "edit";
    case "Read":
      return "read";
    case "Grep":
    case "Glob":
      return "search";
    case "WebFetch":
    case "WebSearch":
      return "fetch";
    default:
      return name.startsWith("mcp__") ? "mcp" : "other";
  }
};

const toolTitle = (name: string, input: Record<string, unknown> | undefined): string => {
  const detail =
    (input?.command as string | undefined) ??
    (input?.file_path as string | undefined) ??
    (input?.pattern as string | undefined) ??
    (input?.url as string | undefined) ??
    (input?.description as string | undefined);
  return detail ? `${name} ${detail}` : name;
};

const resultStatus = (subtype: string, stopReason: string | null | undefined): TurnStatus => {
  if (subtype !== "success") return subtype === "error_max_turns" ? "max_tokens" : "failed";
  if (stopReason === "max_tokens") return "max_tokens";
  if (stopReason === "refusal") return "refused";
  return "completed";
};

const userMessage = (sessionId: string, prompt: ReadonlyArray<ContentBlock>): SDKUserMessage =>
  ({
    type: "user",
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: prompt.map((b) =>
        b.type === "text"
          ? { type: "text", text: b.text }
          : { type: "image", source: { type: "base64", media_type: b.mimeType, data: b.data } },
      ),
    },
  }) as SDKUserMessage;

/**
 * A {@link HarnessDriver} for Claude Code, driven through Anthropic's official
 * Agent SDK — which runs the unmodified `claude` binary. Each session is one
 * long-lived streaming query: prompts are user messages pushed onto its input
 * queue (mid-turn pushes are native steering), and its SDK messages are
 * normalized into session events.
 */
export const claudeCodeDriver = (options: ClaudeCodeOptions = {}): HarnessDriver => ({
  name: "claude-code",
  capabilities: claudeCodeCapabilities,
  defaultCwd: options.cwd ?? "/workspace",
  open: (session: DriverSessionOptions) =>
    Effect.gen(function* () {
      const { query } = yield* Effect.tryPromise({
        // Resolved at runtime from the image (the server's install layer puts
        // it in /app/node_modules with its platform-native `claude` binary);
        // a non-literal specifier keeps bundlers from inlining it.
        try: () =>
          import(/* @vite-ignore */ [CLAUDE_AGENT_SDK, ""].join("")) as Promise<
            typeof import("@anthropic-ai/claude-agent-sdk")
          >,
        catch: (cause) =>
          new SessionError({
            sessionId: session.id,
            message: `@anthropic-ai/claude-agent-sdk is not installed: ${String(cause)}`,
          }),
      });
      const accountEnv = options.accountEnv ? options.accountEnv(session.account) : {};
      if (accountEnv === undefined) {
        return yield* new SessionError({
          sessionId: session.id,
          message: `unknown Claude account ${JSON.stringify(session.account)}`,
        });
      }
      const input = yield* Queue.unbounded<SDKUserMessage, Cause.Done<void>>();
      const permissions = new Map<string, Deferred.Deferred<PermissionResult>>();
      let nextPermission = 0;
      // Turn bookkeeping: the turn the next `result` message closes, and the
      // assistant text it produced.
      let turn: { turnId: string; text: string } | undefined;

      const canUseTool: CanUseTool = (toolName, toolInput) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const requestId = `perm-${++nextPermission}`;
            const answer = yield* Deferred.make<PermissionResult>();
            permissions.set(requestId, answer);
            yield* session.emit({
              type: "permission.requested",
              requestId,
              tool: {
                kind: toolKind(toolName),
                title: toolTitle(toolName, toolInput),
                name: toolName,
                input: toolInput,
              },
              options: [
                { id: "allow", name: "Allow", kind: "allow_once" },
                { id: "deny", name: "Deny", kind: "reject_once" },
              ],
            });
            return yield* Deferred.await(answer);
          }),
        );

      const ask = session.approvals === "ask";
      const q: Query = yield* Effect.try({
        try: () =>
          query({
            prompt: Stream.fromQueue(input).pipe(Stream.toAsyncIterable),
            options: {
              cwd: session.cwd,
              includePartialMessages: true,
              permissionMode: ask ? "default" : (options.permissionMode ?? "bypassPermissions"),
              ...(ask ? { canUseTool } : {}),
              ...(!ask && (options.permissionMode ?? "bypassPermissions") === "bypassPermissions"
                ? { allowDangerouslySkipPermissions: true }
                : {}),
              ...((session.model ?? options.model)
                ? { model: session.model ?? options.model }
                : {}),
              ...(session.systemPrompt
                ? {
                    systemPrompt: {
                      type: "preset",
                      preset: "claude_code",
                      append: session.systemPrompt,
                    },
                  }
                : {}),
              ...(options.executable ? { pathToClaudeCodeExecutable: options.executable } : {}),
              // An empty value removes a variable (an account replacing a default key).
              env: Object.fromEntries(
                Object.entries({
                  ...process.env,
                  // Claude Code refuses to skip permission prompts as root unless
                  // told it is inside a sandbox — which a harness container is.
                  ...(!ask &&
                  (options.permissionMode ?? "bypassPermissions") === "bypassPermissions" &&
                  process.getuid?.() === 0
                    ? { IS_SANDBOX: "1" }
                    : {}),
                  ...options.env,
                  ...accountEnv,
                }).filter(([, value]) => value !== ""),
              ),
            },
          }),
        catch: (cause) =>
          new SessionError({
            sessionId: session.id,
            message: `claude query failed: ${String(cause)}`,
          }),
      });
      yield* Effect.addFinalizer(() =>
        Queue.end(input).pipe(Effect.andThen(Effect.sync(() => q.close?.()))),
      );

      const handle = (message: SDKMessage): Effect.Effect<void> => {
        const turnId = turn?.turnId ?? "turn";
        switch (message.type) {
          case "stream_event": {
            const event = message.event as {
              type: string;
              delta?: { type: string; text?: string; thinking?: string };
            };
            if (event.type !== "content_block_delta" || !event.delta) return Effect.void;
            if (event.delta.type === "text_delta" && event.delta.text) {
              if (turn) turn.text += event.delta.text;
              return session.emit({
                type: "message.delta",
                itemId: message.uuid ?? turnId,
                role: "assistant",
                text: event.delta.text,
                ...(message.parent_tool_use_id ? { parentId: message.parent_tool_use_id } : {}),
              });
            }
            if (event.delta.type === "thinking_delta" && event.delta.thinking) {
              return session.emit({
                type: "reasoning.delta",
                itemId: message.uuid ?? turnId,
                text: event.delta.thinking,
              });
            }
            return Effect.void;
          }
          case "assistant": {
            const blocks = message.message.content as Array<{
              type: string;
              id?: string;
              name?: string;
              input?: Record<string, unknown>;
            }>;
            return Effect.forEach(
              blocks.filter((b) => b.type === "tool_use"),
              (b) =>
                b.name === "Task"
                  ? session.emit({
                      type: "subagent.started",
                      subagentId: b.id!,
                      title: String(b.input?.description ?? "subagent"),
                    })
                  : b.name === "TodoWrite"
                    ? session.emit({
                        type: "plan.updated",
                        entries: (
                          (b.input?.todos as Array<{ content: string; status: string }>) ?? []
                        ).map((t) => ({
                          content: t.content,
                          status: (["pending", "in_progress", "completed"].includes(t.status)
                            ? t.status
                            : "pending") as "pending",
                        })),
                      })
                    : session.emit({
                        type: "tool.started",
                        itemId: b.id!,
                        tool: {
                          kind: toolKind(b.name!),
                          title: toolTitle(b.name!, b.input),
                          name: b.name!,
                          input: b.input,
                        },
                      }),
              { discard: true },
            );
          }
          case "user": {
            const content = message.message.content as unknown;
            if (!Array.isArray(content)) return Effect.void;
            const blocks = content as Array<{
              type: string;
              tool_use_id: string;
              is_error?: boolean;
              content?: unknown;
            }>;
            return Effect.forEach(
              blocks.filter((b) => b.type === "tool_result"),
              (b: { tool_use_id: string; is_error?: boolean; content?: unknown }) =>
                session.emit({
                  type: "tool.completed",
                  itemId: b.tool_use_id,
                  status: b.is_error ? "error" : "ok",
                  content:
                    typeof b.content === "string"
                      ? [{ type: "text", text: b.content }]
                      : Array.isArray(b.content)
                        ? (b.content as Array<{ type: string; text?: string }>)
                            .filter((c) => c.type === "text")
                            .map((c) => ({ type: "text" as const, text: c.text ?? "" }))
                        : [],
                }),
              { discard: true },
            );
          }
          case "result": {
            const finished = turn;
            turn = undefined;
            if (!finished) return Effect.void;
            const u = message.usage as {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
            const usage: Usage = {
              inputTokens: u?.input_tokens ?? 0,
              outputTokens: u?.output_tokens ?? 0,
              ...(u?.cache_read_input_tokens !== undefined
                ? { cacheReadTokens: u.cache_read_input_tokens }
                : {}),
              ...(u?.cache_creation_input_tokens !== undefined
                ? { cacheWriteTokens: u.cache_creation_input_tokens }
                : {}),
              ...(message.total_cost_usd !== undefined ? { costUsd: message.total_cost_usd } : {}),
            };
            const text =
              message.subtype === "success" && typeof message.result === "string"
                ? message.result
                : finished.text;
            return session.emit({
              type: "turn.completed",
              turnId: finished.turnId,
              result: {
                turnId: finished.turnId,
                status: resultStatus(
                  message.subtype,
                  (message as { stop_reason?: string | null }).stop_reason,
                ),
                message: [{ type: "text", text }],
                usage,
                ...(message.subtype !== "success" ? { error: message.subtype } : {}),
              },
            });
          }
          default:
            return Effect.void;
        }
      };

      yield* Stream.fromAsyncIterable(q, (cause) => cause).pipe(
        Stream.runForEach(handle),
        Effect.catchCause((cause) => {
          const message = `claude exited: ${Cause.pretty(cause)}`;
          const running = turn;
          turn = undefined;
          return Effect.andThen(
            session.emit({ type: "error", message }),
            // A dead process can't finish its turn — fail it so `result()` returns.
            running
              ? session.emit({
                  type: "turn.completed",
                  turnId: running.turnId,
                  result: {
                    turnId: running.turnId,
                    status: "failed",
                    message: [{ type: "text", text: running.text }],
                    usage: { inputTokens: 0, outputTokens: 0 },
                    error: message,
                  },
                })
              : Effect.void,
          );
        }),
        Effect.forkScoped,
      );

      const driver: DriverSession = {
        prompt: (turnId, prompt) =>
          Effect.gen(function* () {
            turn = { turnId, text: "" };
            yield* session.emit({ type: "turn.started", turnId });
            yield* Queue.offer(input, userMessage(session.id, prompt));
          }),
        // A user message pushed mid-turn is folded into the running turn.
        steer: (prompt) => Queue.offer(input, userMessage(session.id, prompt)).pipe(Effect.asVoid),
        interrupt: () =>
          Effect.tryPromise({
            try: () => q.interrupt(),
            catch: (cause) =>
              new SessionError({
                sessionId: session.id,
                message: `interrupt failed: ${String(cause)}`,
              }),
          }),
        respond: (requestId: string, answer: Answer) =>
          Effect.gen(function* () {
            const pending = permissions.get(requestId);
            if (!pending) {
              return yield* new SessionError({
                sessionId: session.id,
                message: `no pending request ${requestId}`,
              });
            }
            permissions.delete(requestId);
            yield* Deferred.succeed(
              pending,
              answer.type === "permission" && answer.optionId === "allow"
                ? { behavior: "allow", updatedInput: {} }
                : { behavior: "deny", message: "Denied by the user" },
            );
          }),
      };
      return driver;
    }),
});
