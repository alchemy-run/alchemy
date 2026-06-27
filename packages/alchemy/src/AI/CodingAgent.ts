import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/**
 * The single interface every coding agent exposes, regardless of where it runs.
 * It is shared verbatim by every tag in the system — {@link CodingAgent} (the
 * in-process / app-facing handle), {@link CodingAgentRuntime} (the concrete
 * harness/native implementation), and `CodingAgentContainer` (the same surface
 * exposed over container RPC) — so the agent looks identical in-process, inside
 * a container, and behind a Durable Object; each layer just forwards the calls.
 *
 * A coding agent is a **persistent, continuing agent instance** — a long-lived
 * machine, not a single request. It owns a workspace and conversation session
 * and is identified externally by a stable id (typically a Durable Object). You
 * interact with it the way you would the Flue "continuing agent" model.
 */
export type CodingAgentService = {
  /**
   * Feed an input to the agent. Fire-and-forget: resolves once the input is
   * accepted (queued/started), **not** when the resulting work completes.
   * Observe progress via {@link CodingAgentService.events}. Many inputs can be
   * sent over the agent's lifetime; the agent sequences them against whatever it
   * is already doing.
   */
  readonly send: (
    input: CodingAgentMessage,
  ) => Effect.Effect<void, CodingAgentError>;

  /** Interrupt whatever the agent is currently working on. */
  readonly interrupt: () => Effect.Effect<void, CodingAgentError>;

  /**
   * Open a subscription to the normalized {@link CodingAgentEvent}s the agent
   * emits as it works across all turns. Decoupled from
   * {@link CodingAgentService.send}: a subscriber observes the live stream
   * regardless of who sent the input.
   */
  readonly events: () => Stream.Stream<CodingAgentEvent, CodingAgentError>;

  /**
   * Pull-based alternative to {@link CodingAgentService.events}: return every
   * event observed since `cursor` (a 0-based index into the agent's event
   * history) plus the next cursor to resume from. Unlike `events`, this needs no
   * live stream held open, so it is the transport of choice across boundaries
   * that can't keep a long-lived stream. Callers poll in a loop
   * (`{ events, cursor } = poll(cursor)`), missing nothing between polls because
   * the history is buffered.
   */
  readonly poll: (
    cursor: number,
  ) => Effect.Effect<
    { events: ReadonlyArray<CodingAgentEvent>; cursor: number },
    CodingAgentError
  >;

  /** Read a file from the agent's workspace; `null` if it does not exist. */
  readonly readFile: (
    path: string,
  ) => Effect.Effect<string | null, CodingAgentError>;

  /**
   * List file paths in the agent's workspace, optionally scoped to a
   * sub-directory `path`.
   */
  readonly listFiles: (
    path?: string,
  ) => Effect.Effect<ReadonlyArray<string>, CodingAgentError>;
};

/**
 * Session lifecycle control, exposed by the **runtime** and the
 * `CodingAgentContainer` (NOT by the app-facing {@link CodingAgent} handle).
 *
 * A coding agent hosts exactly one live conversation session at a time, bound to
 * a long-lived runtime process (e.g. the OpenCode bridge inside the container).
 * These methods let a durable owner (a Durable Object) pick which session that
 * process runs, so the session identity can be persisted durably and survive the
 * ephemeral container — the DO stores the id and re-asserts it whenever the
 * container (re)starts.
 */
export type CodingAgentSessionControl = {
  /**
   * Make `sessionId` the agent's active conversation, tearing down the previous
   * one (and interrupting any in-flight turn). Idempotent: switching to the id
   * that is already active is a no-op. Returns the now-active id.
   */
  readonly switchSession: (
    sessionId: string,
  ) => Effect.Effect<string, CodingAgentError>;

  /** The id of the currently active session. */
  readonly currentSession: () => Effect.Effect<string, CodingAgentError>;
};

/**
 * The in-process / app-facing coding agent handle. Its interface is
 * {@link CodingAgentService} — the same surface as {@link CodingAgentRuntime}
 * and `CodingAgentContainer`.
 */
export class CodingAgent extends Context.Service<
  CodingAgent,
  CodingAgentService
>()("@alchemy.run/AI/CodingAgent") {}

/**
 * Token accounting reported at step and turn boundaries. Mirrors
 * `LanguageModelV4Usage` from the AI SDK — every field is optional because a
 * runtime may not report all of them. Monetary cost is intentionally absent:
 * the projected harness stream does not carry it (compute it downstream from
 * tokens + model pricing if needed).
 */
export const CodingAgentUsage = Schema.Struct({
  inputTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number),
  totalTokens: Schema.optional(Schema.Number),
  reasoningTokens: Schema.optional(Schema.Number),
  cachedInputTokens: Schema.optional(Schema.Number),
});
export type CodingAgentUsage = typeof CodingAgentUsage.Type;

/** A single turn's request. */
export const CodingAgentInput = Schema.Struct({
  /**
   * Stable session identifier. Implementations use it to persist and resume
   * native conversation history across turns.
   */
  session: Schema.String,
  /** The user's input for this turn. */
  prompt: Schema.String,
  /**
   * Provider/model identifier the agent should use, e.g.
   * `"anthropic/claude-sonnet-4-5"`. Implementations map it to their runtime.
   */
  model: Schema.String,
  /** Absolute path to the workspace (repo checkout) the agent operates on. */
  workspace: Schema.String,
  /** Optional extra instructions appended to the agent's system prompt. */
  system: Schema.optional(Schema.String),
});
export type CodingAgentInput = typeof CodingAgentInput.Type;

/**
 * The payload for one {@link CodingAgent.send}. A persistent agent already owns
 * its workspace and session, so a message only carries the per-turn input — the
 * prompt plus optional per-turn overrides.
 */
export const CodingAgentMessage = Schema.Struct({
  /** The user's input for this turn. */
  prompt: Schema.String,
  /**
   * Provider/model identifier to use for this turn, overriding the agent's
   * configured default, e.g. `"anthropic/claude-sonnet-4-5"`.
   */
  model: Schema.optional(Schema.String),
  /** Optional extra instructions appended to the agent's system prompt. */
  system: Schema.optional(Schema.String),
});
export type CodingAgentMessage = typeof CodingAgentMessage.Type;

/**
 * Normalized streaming events. These map 1:1 onto the AI SDK harness stream
 * (`HarnessV1StreamPart` / the projected `StreamTextResult.fullStream`) so the
 * OpenCode adapter is a thin rename, and equally onto OpenCode's own `LLMEvent`
 * stream for a native implementation.
 *
 * Construct events via the generated case builders, e.g.
 * `CodingAgentEvent.cases.TextDelta.make({ text })`, and narrow with
 * `CodingAgentEvent.guards.ToolCall(event)` or `CodingAgentEvent.match`.
 */
export const CodingAgentEvent = Schema.TaggedUnion({
  /** The turn's stream opened; carries the resolved model id when known. (`stream-start`) */
  StreamStart: { modelId: Schema.optional(Schema.String) },
  /** A new step within the turn began. (`start-step`) */
  StepStart: {},
  /** Incremental assistant message text. (`text-delta`) */
  TextDelta: { text: Schema.String },
  /** Incremental model reasoning, when exposed. (`reasoning-delta`) */
  ReasoningDelta: { text: Schema.String },
  /** The agent invoked a tool. (`tool-call`) */
  ToolCall: {
    id: Schema.String,
    name: Schema.String,
    input: Schema.Unknown,
  },
  /** A tool returned a result. (`tool-result`) */
  ToolResult: {
    id: Schema.String,
    name: Schema.String,
    output: Schema.Unknown,
  },
  /** A tool failed; non-fatal — fed back to the model. (`tool-error`) */
  ToolError: {
    id: Schema.String,
    name: Schema.String,
    error: Schema.String,
  },
  /**
   * A single workspace file changed. Mirrors the harness `file-change` part
   * exactly — one path with a create/modify/delete verb. Rich diff stats
   * (additions/deletions/patch) are derived separately from git, since posts
   * are repositories.
   */
  FileChange: {
    event: Schema.Literals(["create", "modify", "delete"]),
    path: Schema.String,
  },
  /** A non-fatal error surfaced mid-stream. (`error`) */
  Error: { error: Schema.String },
  /** A step completed with a finish reason and usage. (`finish-step`) */
  StepFinish: { reason: Schema.String, usage: CodingAgentUsage },
  /** The turn completed. (`finish`, `totalUsage`) */
  Finish: { reason: Schema.String, usage: CodingAgentUsage },
});
export type CodingAgentEvent = typeof CodingAgentEvent.Type;

/** Failure of a {@link CodingAgent} turn. */
export class CodingAgentError extends Schema.TaggedErrorClass<CodingAgentError>()(
  "@alchemy.run/AI/CodingAgentError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** Configuration for the reference {@link makeCodingAgent} actor. */
export interface CodingAgentConfig {
  /** Absolute path to the workspace (repo checkout) the agent operates on. */
  readonly workspace: string;
  /**
   * Default provider/model identifier, e.g. `"anthropic/claude-sonnet-4-5"`.
   * Overridable per turn via {@link CodingAgentMessage.model}.
   */
  readonly model: string;
  /**
   * Stable session id used for the agent's continuing conversation. Generated
   * once if omitted.
   */
  readonly session?: string;
  /** Default extra instructions appended to the agent's system prompt. */
  readonly instructions?: string;
}

/**
 * A function that runs **one prompt** against a workspace and streams back the
 * normalized {@link CodingAgentEvent}s for that single turn, ending with a
 * `Finish`. This is the private per-prompt primitive an implementation supplies
 * to {@link makeCodingAgentService}; it is NOT a public interface — it maps onto
 * the underlying runtime's per-call streaming API (e.g. the AI SDK harness's
 * `HarnessAgent.stream({ session, prompt }).fullStream`).
 */
export type CodingAgentPrompt = (
  input: CodingAgentInput,
) => Stream.Stream<CodingAgentEvent, CodingAgentError>;

/**
 * Build the reference {@link CodingAgentService} actor: an in-memory persistent
 * machine that owns a workspace and session, processes
 * {@link CodingAgentService.send} inputs one turn at a time by invoking
 * `runPrompt`, fans the resulting events out over a pub/sub to
 * {@link CodingAgentService.events} subscribers (and buffers them for `poll`),
 * and answers workspace queries via the {@link FileSystem.FileSystem}.
 *
 * Implementations (a harness adapter such as OpenCode, or a native runtime)
 * supply `runPrompt` and provide the result under whichever tag fits — typically
 * {@link CodingAgentRuntime}. The processor loop is forked into the calling
 * scope, so wrap this in a `Layer.effect(Tag, makeCodingAgentService(...))` so
 * it lives for the layer's lifetime.
 */
export const makeCodingAgentService = (
  config: CodingAgentConfig,
  runPrompt: CodingAgentPrompt,
): Effect.Effect<
  CodingAgentService,
  never,
  FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const session =
      config.session ?? (yield* Effect.sync(() => crypto.randomUUID()));

    // `events` is a pub/sub so observing is decoupled from sending and many
    // subscribers can watch the same agent; `mailbox` serializes inputs into
    // one-turn-at-a-time processing; `current` holds the running turn so
    // `interrupt` can stop it.
    const events = yield* PubSub.unbounded<CodingAgentEvent>();
    const mailbox = yield* Queue.unbounded<CodingAgentMessage>();
    const current = yield* Ref.make<Fiber.Fiber<void, never> | undefined>(
      undefined,
    );
    // Buffered event history so `poll` can serve subscribers that can't hold a
    // live `events` stream (e.g. a Durable Object). Every published event is
    // appended here too.
    const history = yield* Ref.make<ReadonlyArray<CodingAgentEvent>>([]);

    const publish = (event: CodingAgentEvent) =>
      Ref.update(history, (h) => [...h, event]).pipe(
        Effect.andThen(PubSub.publish(events, event)),
      );

    const runTurn = (message: CodingAgentMessage) =>
      runPrompt({
        session,
        prompt: message.prompt,
        model: message.model ?? config.model,
        workspace: config.workspace,
        system: message.system ?? config.instructions,
      }).pipe(
        Stream.runForEach(publish),
        // A failed turn surfaces as an in-band Error event rather than
        // tearing down the processor loop.
        Effect.catch((error) =>
          publish({ _tag: "Error", error: error.message }).pipe(Effect.asVoid),
        ),
      );

    yield* Effect.forkScoped(
      Effect.forever(
        Queue.take(mailbox).pipe(
          Effect.flatMap((message) =>
            runTurn(message).pipe(
              Effect.forkChild,
              Effect.flatMap((fiber) =>
                Ref.set(current, fiber).pipe(
                  Effect.andThen(Fiber.await(fiber)),
                ),
              ),
            ),
          ),
        ),
      ),
    );

    const resolve = (path: string) =>
      path.startsWith("/") ? path : `${config.workspace}/${path}`;

    const toError = (message: string) => (cause: unknown) =>
      new CodingAgentError({ message, cause });

    return {
      send: (message) => Queue.offer(mailbox, message).pipe(Effect.asVoid),

      interrupt: () =>
        Ref.get(current).pipe(
          Effect.flatMap((fiber) =>
            fiber ? Fiber.interrupt(fiber) : Effect.void,
          ),
        ),

      events: () => Stream.fromPubSub(events),

      poll: (cursor) =>
        Ref.get(history).pipe(
          Effect.map((h) => ({
            events: h.slice(Math.max(0, cursor)),
            cursor: h.length,
          })),
        ),

      readFile: (path) =>
        Effect.gen(function* () {
          const full = resolve(path);
          if (!(yield* fs.exists(full))) return null;
          return yield* fs.readFileString(full);
        }).pipe(Effect.mapError(toError(`readFile ${path} failed`))),

      listFiles: (path) =>
        fs
          .readDirectory(resolve(path ?? "."))
          .pipe(Effect.mapError(toError(`listFiles ${path ?? "."} failed`))),
    };
  });
