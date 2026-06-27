import { HarnessAgent, type HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import type { LanguageModelUsage, TextStreamPart, ToolSet } from "ai";
import {
  type CodingAgentConfig,
  CodingAgentError,
  type CodingAgentEvent,
  type CodingAgentInput,
  type CodingAgentPrompt,
  CodingAgentRuntime,
  type CodingAgentService,
  type CodingAgentSessionControl,
  type CodingAgentUsage,
  makeCodingAgentService,
} from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { makeLocalSandbox, type LocalSandboxServices } from "./LocalSandbox.ts";

/** The live harness session handle returned by `agent.createSession`. */
type HarnessSession = Awaited<ReturnType<HarnessAgent["createSession"]>>;

/**
 * Build a {@link CodingAgentRuntime} `Layer` from any Vercel AI SDK harness
 * adapter (`@ai-sdk/harness-opencode`, `-claude-code`, `-codex`, …). The
 * `harnessFor` factory receives each turn's input so the underlying runtime can
 * be configured with the requested model; the adapter handles the sandbox,
 * session lifecycle, and the translation of the AI SDK stream into
 * {@link CodingAgentEvent}s.
 *
 * The result is the **full** {@link CodingAgentRuntime} — the persistent agent
 * built by `makeCodingAgentService` (mailbox, event pub/sub, interrupt, buffered
 * history) wrapping the harness's per-prompt `stream()` call. The per-prompt
 * streaming is a private detail here, never a public interface.
 *
 * The Layer requires {@link LocalSandboxServices} — provide it inside the
 * Container the harness runs in (e.g. the Bun platform context).
 */
export const makeCodingAgentRuntime = (
  harnessFor: (input: CodingAgentInput) => HarnessAgentAdapter,
  config: CodingAgentConfig,
): Layer.Layer<CodingAgentRuntime, never, LocalSandboxServices> =>
  Layer.effect(
    CodingAgentRuntime,
    Effect.gen(function* () {
      // Build the sandbox + harness agent ONCE, for the container's lifetime.
      // The harness is configured with a single model + workspace for that
      // lifetime, so synthesize a base input from `config`. Per-turn `model` /
      // `system` overrides aren't honored — switching models would require a new
      // bridge, which defeats the persistent session.
      const baseInput: CodingAgentInput = {
        session:
          config.session ?? (yield* Effect.sync(() => crypto.randomUUID())),
        prompt: "",
        model: config.model,
        workspace: config.workspace,
        system: config.instructions,
      };

      const sandbox = yield* makeLocalSandbox(dirname(config.workspace));
      const agent = new HarnessAgent({
        harness: harnessFor(baseInput),
        sandbox,
        sandboxConfig: { workDir: basename(config.workspace) },
        instructions: config.instructions,
      });

      // The active conversation. `desiredId` is the id we *want* to run (set by
      // the durable owner via `switchSession`); `live` holds the running harness
      // session once created. Booting the OpenCode bridge (`node bridge.mjs`,
      // which must "become ready" before the model runs) is the expensive step,
      // so it happens once per session and the bridge then stays up for the
      // container's lifetime — a `send` only pays for the model call.
      const desiredId = yield* Ref.make(baseInput.session);
      const live = yield* Ref.make<HarnessSession | undefined>(undefined);
      // Serialize session create/switch/teardown against each other.
      const lock = Semaphore.makeUnsafe(1);

      const open = (sessionId: string) =>
        Effect.tryPromise({
          try: () => agent.createSession({ sessionId }),
          catch: (error) =>
            new CodingAgentError({
              message: `createSession failed: ${errorText(error)}`,
              cause: error,
            }),
        });

      const close = (session: HarnessSession | undefined) =>
        session === undefined
          ? Effect.void
          : Effect.promise(() => session.destroy());

      // Destroy whatever session is live when the container scope closes.
      yield* Effect.addFinalizer(() =>
        Ref.get(live).pipe(Effect.flatMap(close)),
      );

      // Get the live session, creating it (with the desired id) on first use.
      const ensureSession = Semaphore.withPermits(
        lock,
        1,
      )(
        Effect.gen(function* () {
          const existing = yield* Ref.get(live);
          if (existing !== undefined) return existing;
          const id = yield* Ref.get(desiredId);
          yield* Effect.log(`[CodingAgent] opening session ${id}...`);
          const session = yield* open(id);
          yield* Ref.set(live, session);
          yield* Effect.log(`[CodingAgent] session ${id} ready`);
          return session;
        }),
      );

      const switchSession = (sessionId: string) =>
        Semaphore.withPermits(
          lock,
          1,
        )(
          Effect.gen(function* () {
            const current = yield* Ref.get(desiredId);
            const existing = yield* Ref.get(live);
            if (sessionId === current && existing !== undefined) {
              return sessionId;
            }
            // Tear down the old session (aborts any in-flight turn on it) and
            // open the new one eagerly so the bridge is warm for the next send.
            yield* close(existing);
            yield* Ref.set(live, undefined);
            yield* Ref.set(desiredId, sessionId);
            yield* Effect.log(
              `[CodingAgent] switching to session ${sessionId}...`,
            );
            const session = yield* open(sessionId);
            yield* Ref.set(live, session);
            yield* Effect.log(`[CodingAgent] session ${sessionId} ready`);
            return sessionId;
          }),
        );

      // The private per-prompt primitive: run one prompt on the current session
      // and stream its parts as normalized events. The persistent actor feeds
      // queued inputs through this one turn at a time.
      //
      // An `AbortController` is scoped to the stream's lifetime: when the
      // consuming fiber is interrupted (CodingAgent.interrupt → Fiber.interrupt),
      // the stream scope closes and aborts the turn — WITHOUT destroying the
      // session, so the next `send` reuses the same running bridge.
      const runPrompt: CodingAgentPrompt = (input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const session = yield* ensureSession;
            // Abort the turn ONLY when the consuming fiber is interrupted
            // (CodingAgent.interrupt). On normal completion we must NOT abort:
            // since the session/bridge is reused across turns, a stray abort
            // after a turn finishes tears the bridge down and the next turn
            // fails with "bridge closed before the turn finished".
            const controller = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (c, exit) =>
                Exit.hasInterrupts(exit)
                  ? Effect.sync(() => c.abort())
                  : Effect.void,
            );
            yield* Effect.log(`[CodingAgent] prompt: model=${config.model}`);
            const result = yield* Effect.tryPromise({
              try: () =>
                agent.stream({
                  session,
                  prompt: input.prompt,
                  abortSignal: controller.signal,
                }),
              catch: (error) =>
                new CodingAgentError({
                  message: `stream failed: ${errorText(error)}`,
                  cause: error,
                }),
            });
            yield* Effect.log("[CodingAgent] stream open, draining parts...");
            return Stream.fromAsyncIterable(
              result.fullStream,
              (error) =>
                new CodingAgentError({
                  message: errorText(error),
                  cause: error,
                }),
            ).pipe(
              Stream.flatMap((part) => {
                const event = toEvent(part);
                return event === null ? Stream.empty : Stream.make(event);
              }),
            );
          }),
        );

      const service = yield* makeCodingAgentService(config, runPrompt);

      return {
        ...service,
        switchSession,
        currentSession: () => Ref.get(desiredId),
      } satisfies CodingAgentService & CodingAgentSessionControl;
    }),
  );

const dirname = (p: string): string => {
  const trimmed = p.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
};

const basename = (p: string): string => {
  const trimmed = p.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
};

const errorText = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : (JSON.stringify(error) ?? String(error));

const toUsage = (usage: LanguageModelUsage): CodingAgentUsage => ({
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  totalTokens: usage.totalTokens,
});

/**
 * Translate one AI SDK harness stream part into a normalized
 * {@link CodingAgentEvent}, or `null` for parts we don't surface (tool-input
 * streaming, sources, approvals, raw, …).
 */
const toEvent = (part: TextStreamPart<ToolSet>): CodingAgentEvent | null => {
  switch (part.type) {
    case "start-step":
      return { _tag: "StepStart" };
    case "text-delta":
      return { _tag: "TextDelta", text: part.text };
    case "reasoning-delta":
      return { _tag: "ReasoningDelta", text: part.text };
    case "tool-call":
      return {
        _tag: "ToolCall",
        id: part.toolCallId,
        name: part.toolName,
        input: part.input,
      };
    case "tool-result":
      return {
        _tag: "ToolResult",
        id: part.toolCallId,
        name: part.toolName,
        output: part.output,
      };
    case "tool-error":
      return {
        _tag: "ToolError",
        id: part.toolCallId,
        name: part.toolName,
        error: errorText(part.error),
      };
    case "finish-step":
      return {
        _tag: "StepFinish",
        reason: part.finishReason,
        usage: toUsage(part.usage),
      };
    case "finish":
      return {
        _tag: "Finish",
        reason: part.finishReason,
        usage: toUsage(part.totalUsage),
      };
    case "error":
      return { _tag: "Error", error: errorText(part.error) };
    default:
      return null;
  }
};
