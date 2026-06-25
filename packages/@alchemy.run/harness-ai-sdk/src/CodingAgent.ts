import { HarnessAgent, type HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import type { LanguageModelUsage, TextStreamPart, ToolSet } from "ai";
import {
  type CodingAgentConfig,
  CodingAgentError,
  type CodingAgentEvent,
  type CodingAgentInput,
  type CodingAgentPrompt,
  CodingAgentRuntime,
  type CodingAgentUsage,
  makeCodingAgentService,
} from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { makeLocalSandbox, type LocalSandboxServices } from "./LocalSandbox.ts";

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
      const context = yield* Effect.context<LocalSandboxServices>();

      // The private per-prompt primitive: run one prompt through the harness and
      // stream its parts as normalized events. The persistent actor below feeds
      // queued inputs through this one turn at a time.
      const runPrompt: CodingAgentPrompt = (input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* Effect.log(
              `[CodingAgent] prompt: workspace=${input.workspace} model=${input.model}`,
            );
            const sandbox = yield* makeLocalSandbox(dirname(input.workspace));
            const agent = new HarnessAgent({
              harness: harnessFor(input),
              sandbox,
              sandboxConfig: { workDir: basename(input.workspace) },
              instructions: input.system ?? config.instructions,
            });
            yield* Effect.log("[CodingAgent] creating session...");
            const session = yield* Effect.acquireRelease(
              Effect.tryPromise({
                try: () => agent.createSession({ sessionId: input.session }),
                catch: (error) =>
                  new CodingAgentError({
                    message: `createSession failed: ${errorText(error)}`,
                    cause: error,
                  }),
              }),
              (s) => Effect.promise(() => s.destroy()),
            );
            yield* Effect.log(
              "[CodingAgent] session ready, starting stream...",
            );
            const result = yield* Effect.tryPromise({
              try: () => agent.stream({ session, prompt: input.prompt }),
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
          }).pipe(Effect.provide(context)),
        );

      return yield* makeCodingAgentService(config, runPrompt);
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
