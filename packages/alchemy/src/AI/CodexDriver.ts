import * as Codex from "@distilled.cloud/codex";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
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
  type SessionEventInput,
  type TurnStatus,
} from "./Session.ts";
import { spawnStdio } from "./Stdio.ts";

export interface CodexOptions {
  /** The `codex` executable. @default "codex" */
  readonly command?: string;
  /** Arguments before `app-server` (e.g. `["-y", "@openai/codex", …]` for npx). */
  readonly args?: ReadonlyArray<string>;
  /** Extra environment for the app-server (credentials, base URL). */
  readonly env?: Record<string, string | undefined>;
  /** Default model. */
  readonly model?: string;
  /** Sandbox policy for commands Codex runs. @default "danger-full-access" (the container is the sandbox) */
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** Default working directory. @default "/workspace" */
  readonly cwd?: string;
}

/** Codex steers natively (`turn/steer`), forks threads, and runs subagents. */
export const codexCapabilities: Capabilities = {
  steering: "native",
  queuedPrompts: false,
  fork: false,
  rollback: false,
  subagents: true,
  plans: true,
  reasoning: true,
  modelSwitching: true,
};

const turnStatus = (status: string): TurnStatus =>
  status === "interrupted" ? "interrupted" : status === "failed" ? "failed" : "completed";

const toInput = (prompt: ReadonlyArray<ContentBlock>): Codex.UserInput[] =>
  prompt.map(
    (b) =>
      (b.type === "text"
        ? { type: "text", text: b.text, text_elements: [] }
        : { type: "image", url: `data:${b.mimeType};base64,${b.data}` }) as Codex.UserInput,
  );

interface Routed {
  readonly options: DriverSessionOptions;
  /** Our turn id ↔ Codex's turn id for the running turn, plus its final text. */
  turn: { readonly turnId: string; nativeTurnId: string | undefined; text: string } | undefined;
  readonly approvals: Map<string, Deferred.Deferred<boolean>>;
}

/**
 * A {@link HarnessDriver} for OpenAI Codex over `codex app-server`
 * (JSON-RPC on stdio, via `@distilled.cloud/codex`). One app-server process
 * serves every session; each session is one Codex thread, and notifications
 * and approval requests are routed by thread id.
 */
export const codexDriver = (
  options: CodexOptions = {},
): Effect.Effect<HarnessDriver, SessionError, ChildProcessSpawner | Scope.Scope> =>
  Effect.gen(function* () {
    const threads = new Map<string, Routed>();
    let nextApproval = 0;

    const approve = (threadId: string, title: string, kind: "shell" | "edit", input: unknown) =>
      Effect.gen(function* () {
        const routed = threads.get(threadId);
        if (!routed || routed.options.approvals === "auto") return true;
        const requestId = `approval-${++nextApproval}`;
        const answer = yield* Deferred.make<boolean>();
        routed.approvals.set(requestId, answer);
        yield* routed.options.emit({
          type: "permission.requested",
          requestId,
          tool: { kind, title, input },
          options: [
            { id: "accept", name: "Accept", kind: "allow_once" },
            { id: "decline", name: "Decline", kind: "reject_once" },
          ],
        });
        return yield* Deferred.await(answer);
      });

    const handlers: Codex.InboundHandlers = {
      itemCommandExecutionRequestApproval: (req) =>
        approve(req.threadId, req.command ?? "command", "shell", req).pipe(
          Effect.map(
            (ok) =>
              ({
                decision: ok ? "accept" : "decline",
              }) as Codex.CommandExecutionRequestApprovalResponse,
          ),
        ),
      itemFileChangeRequestApproval: (req) =>
        approve(req.threadId, req.reason ?? "file change", "edit", req).pipe(
          Effect.map(
            (ok) =>
              ({ decision: ok ? "accept" : "decline" }) as Codex.FileChangeRequestApprovalResponse,
          ),
        ),
    };

    const connection = yield* Codex.connect(
      yield* spawnStdio({
        command: options.command ?? "codex",
        args: [...(options.args ?? []), "app-server"],
        ...(options.env ? { env: options.env } : {}),
      }),
      { handlers },
    );
    const run = <A, E>(effect: Effect.Effect<A, E, Codex.CodexConnection>) =>
      effect.pipe(
        Effect.provideService(Codex.CodexConnection, connection),
        Effect.mapError(
          (e) => new SessionError({ message: String((e as { message?: string }).message ?? e) }),
        ),
      );

    yield* run(Codex.initialize({ clientInfo: { name: "alchemy", version: "2" } }));
    yield* run(Codex.initialized());

    // Route every notification to its thread's session.
    const route = <N extends { threadId: string }>(
      stream: Stream.Stream<N, never, Codex.CodexConnection>,
      f: (routed: Routed, n: N) => Effect.Effect<void>,
    ) =>
      stream.pipe(
        Stream.runForEach((n) => {
          const routed = threads.get(n.threadId);
          return routed ? f(routed, n) : Effect.void;
        }),
      );
    const emit = (routed: Routed, event: SessionEventInput) => routed.options.emit(event);
    const item = (n: { item: unknown }) =>
      n.item as { type: string; id: string } & Record<string, any>;

    yield* Effect.all(
      [
        // Codex retries transport failures itself; surface each attempt so a
        // stuck turn is visible instead of silent.
        route(Codex.error, (r, n) =>
          emit(r, {
            type: "error",
            message: `${n.error.message}${n.willRetry ? " (retrying)" : ""}`,
          }),
        ),
        route(Codex.itemAgentMessageDelta, (r, n) => {
          if (r.turn) r.turn.text += n.delta;
          return emit(r, {
            type: "message.delta",
            itemId: n.itemId,
            role: "assistant",
            text: n.delta,
          });
        }),
        route(Codex.itemReasoningTextDelta, (r, n) =>
          emit(r, { type: "reasoning.delta", itemId: n.itemId, text: n.delta }),
        ),
        route(Codex.itemReasoningSummaryTextDelta, (r, n) =>
          emit(r, { type: "reasoning.delta", itemId: n.itemId, text: n.delta }),
        ),
        route(Codex.itemCommandExecutionOutputDelta, (r, n) =>
          emit(r, { type: "tool.output", itemId: n.itemId, chunk: n.delta }),
        ),
        route(Codex.itemStarted, (r, n) => {
          const it = item(n);
          switch (it.type) {
            case "commandExecution":
              return emit(r, {
                type: "tool.started",
                itemId: it.id,
                tool: { kind: "shell", title: it.command, name: "shell" },
              });
            case "fileChange":
              return emit(r, {
                type: "tool.started",
                itemId: it.id,
                tool: { kind: "edit", title: "edit files", name: "apply_patch" },
              });
            case "mcpToolCall":
              return emit(r, {
                type: "tool.started",
                itemId: it.id,
                tool: {
                  kind: "mcp",
                  title: `${it.server}.${it.tool}`,
                  name: it.tool,
                  input: it.arguments,
                },
              });
            case "webSearch":
              return emit(r, {
                type: "tool.started",
                itemId: it.id,
                tool: { kind: "fetch", title: `search ${it.query ?? ""}`, name: "web_search" },
              });
            default:
              return Effect.void;
          }
        }),
        route(Codex.itemCompleted, (r, n) => {
          const it = item(n);
          switch (it.type) {
            case "commandExecution":
              return emit(r, {
                type: "tool.completed",
                itemId: it.id,
                status: it.exitCode === 0 || it.exitCode == null ? "ok" : "error",
                content: [
                  {
                    type: "terminal",
                    output: it.aggregatedOutput ?? "",
                    ...(typeof it.exitCode === "number" ? { exitCode: it.exitCode } : {}),
                  },
                ],
              });
            case "fileChange":
              return emit(r, {
                type: "tool.completed",
                itemId: it.id,
                status: it.status === "failed" ? "error" : "ok",
                content: ((it.changes ?? []) as Array<{ path: string; diff?: string }>).map(
                  (c) => ({
                    type: "diff" as const,
                    path: c.path,
                    newText: c.diff ?? "",
                  }),
                ),
              });
            case "mcpToolCall":
            case "webSearch":
              return emit(r, { type: "tool.completed", itemId: it.id, status: "ok", content: [] });
            default:
              return Effect.void;
          }
        }),
        route(Codex.turnPlanUpdated, (r, n) =>
          emit(r, {
            type: "plan.updated",
            entries: n.plan.map((p) => ({
              content: p.step,
              status: (p.status === "inProgress"
                ? "in_progress"
                : p.status === "completed"
                  ? "completed"
                  : "pending") as "pending",
            })),
          }),
        ),
        route(Codex.turnCompleted, (r, n) => {
          const finished = r.turn;
          if (!finished || (finished.nativeTurnId && finished.nativeTurnId !== n.turn.id))
            return Effect.void;
          r.turn = undefined;
          return emit(r, {
            type: "turn.completed",
            turnId: finished.turnId,
            result: {
              turnId: finished.turnId,
              status: turnStatus(n.turn.status),
              message: [{ type: "text", text: finished.text }],
              usage: emptyUsage,
              ...(n.turn.error ? { error: n.turn.error.message } : {}),
            },
          });
        }),
      ],
      { concurrency: "unbounded", discard: true },
    ).pipe(Effect.provideService(Codex.CodexConnection, connection), Effect.forkScoped);

    const open = (session: DriverSessionOptions) =>
      Effect.gen(function* () {
        const sessionScope = yield* Scope.Scope;
        const started = yield* run(
          Codex.threadStart({
            cwd: session.cwd,
            approvalPolicy: session.approvals === "ask" ? "on-request" : "never",
            sandbox: options.sandbox ?? "danger-full-access",
            ...((session.model ?? options.model) ? { model: session.model ?? options.model } : {}),
            ...(session.systemPrompt ? { developerInstructions: session.systemPrompt } : {}),
          }),
        );
        const threadId = started.thread.id;
        const routed: Routed = { options: session, turn: undefined, approvals: new Map() };
        threads.set(threadId, routed);
        yield* Effect.addFinalizer(() => Effect.sync(() => threads.delete(threadId)));

        // `turn/start` takes a model override that sticks for later turns;
        // a switch is sent with the next turn.
        let pendingModel: string | undefined;
        const driver: DriverSession = {
          prompt: (turnId, prompt) =>
            Effect.gen(function* () {
              routed.turn = { turnId, nativeTurnId: undefined, text: "" };
              yield* session.emit({ type: "turn.started", turnId });
              const model = pendingModel;
              pendingModel = undefined;
              const response = yield* run(
                Codex.turnStart({
                  threadId,
                  input: toInput(prompt),
                  ...(model !== undefined ? { model } : {}),
                }),
              );
              if (routed.turn?.turnId === turnId) routed.turn.nativeTurnId = response.turn.id;
            }).pipe(Effect.forkIn(sessionScope), Effect.asVoid),
          steer: (prompt) =>
            Effect.gen(function* () {
              const native = routed.turn?.nativeTurnId;
              if (!native) return yield* new SessionError({ message: "no running turn to steer" });
              yield* run(
                Codex.turnSteer({ threadId, expectedTurnId: native, input: toInput(prompt) }),
              );
            }),
          interrupt: () =>
            Effect.gen(function* () {
              const native = routed.turn?.nativeTurnId;
              if (native) yield* run(Codex.turnInterrupt({ threadId, turnId: native }));
            }),
          setModel: (model) =>
            Effect.sync(() => {
              pendingModel = model;
            }),
          respond: (requestId: string, answer: Answer) =>
            Effect.gen(function* () {
              const pending = routed.approvals.get(requestId);
              if (!pending)
                return yield* new SessionError({ message: `no pending request ${requestId}` });
              routed.approvals.delete(requestId);
              yield* Deferred.succeed(
                pending,
                answer.type === "permission" && answer.optionId === "accept",
              );
            }),
        };
        return driver;
      });

    return {
      name: "codex",
      capabilities: codexCapabilities,
      defaultCwd: options.cwd ?? "/workspace",
      ...(options.model ? { defaultModel: options.model } : {}),
      open,
    } satisfies HarnessDriver;
  });
