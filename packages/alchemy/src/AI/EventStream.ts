import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { RuntimeContext } from "../RuntimeContext.ts";
import { makeChunkTranslator } from "./UIMessage.ts";

/**
 * The ENCODED form of a round failure — what a `crashed` observation
 * carries across storage and RPC. The driver never renders errors
 * (spec §11b): projections, boards, and UIs own presentation.
 * JSON-serializable by construction, like every observation.
 */
export interface EncodedCrash {
  /** The error's tag — for AiErrors, the semantic REASON tag
   *  (`InvalidRequestError`, `RateLimitError`, …), not the wrapper. */
  readonly _tag: string | undefined;
  /** One human-readable line — no stack, no `Cause(...)` wrapper. */
  readonly message: string;
  /**
   * The error's own testimony on whether re-running could succeed
   * (`AiError.isRetryable`). Errors carrying no testimony default to
   * retryable — the recovery loop's bounded budget is the safety net.
   */
  readonly retryable: boolean;
}

/**
 * A round exhausted its recovery budget (interrupted `attempts` times
 * with no completed sampling) and was abandoned — the typed failure
 * every waiter on that round receives.
 */
export class RoundAbandoned extends Data.TaggedError("RoundAbandoned")<{
  readonly term: string;
  readonly key: string;
  readonly attempts: number;
}> {
  override get message() {
    return (
      `session '${this.term}/${this.key}': round abandoned after ` +
      `${this.attempts} interrupted attempts`
    );
  }
}

/**
 * The envelope every observation carries: which session it belongs to
 * (`term` + `key`), WHERE in that session's history it sits (`seq` — a
 * per-session monotonic sequence, the resume/dedupe cursor), and when.
 */
export interface ObservationEnvelope {
  readonly term: string;
  readonly key: string;
  /** Per-session monotonic sequence number — the catch-up cursor. */
  readonly seq: number;
  readonly at: number;
}

/**
 * One structured fact about a driver's execution — enough to
 * reconstruct every session's TRANSCRIPT (inputs, assistant text, tool
 * calls and their results) and to stream it live. Deliberately the
 * DRIVER's vocabulary, not any UI protocol's: every surveyed harness
 * (Codex, OpenCode, Mastra, flue) keeps a canonical internal event log
 * and translates at the edge (see designs/ai/streaming.md).
 * JSON-serializable by construction.
 */
export type SessionObservation = ObservationEnvelope &
  (
    | {
        readonly type: "admitted";
        /** The session whose dispatch/send caused this admission, if any. */
        readonly parent?: { readonly term: string; readonly key: string };
      }
    | {
        /** A message appended to the session's thread: work item, steer, or note. */
        readonly type: "input";
        readonly text: string;
        /**
         * PROVENANCE, structural: `note` = driver-authored aside
         * (`AI.say`, recovery notes); `reminder` = a `Thread.remind`
         * delivery (the session's own past self). Absent = an ordinary
         * message (world event or steer). The in-band text markers
         * (`<note>`, `[reminder]`) remain — they are MODEL-facing;
         * this field is for projections, which must never parse them.
         */
        readonly kind?: "note" | "reminder";
      }
    | {
        /**
         * One TOKEN SLICE of an in-flight sampling — text or thinking as
         * the provider streams it. Purely a live-view fact: the final
         * `assistant` observation restates the whole sampling and is the
         * canonical record (deltas need not be retained, and a transient
         * provider retry may replay them).
         */
        readonly type: "assistant-delta";
        readonly tick: number;
        readonly channel: "text" | "reasoning";
        readonly delta: string;
      }
    | {
        /**
         * A tool call the IN-FLIGHT sampling just made, surfaced the
         * moment it streams — its handler may run for minutes (a
         * dispatched subagent) before the sampling's final `assistant`
         * observation restates it. Live-view fact, same caveats as
         * `assistant-delta`.
         */
        readonly type: "tool-call";
        readonly tick: number;
        readonly toolCallId: string;
        readonly toolName: string;
        readonly input: unknown;
      }
    | {
        /** One sampling's response — text and/or tool calls. */
        readonly type: "assistant";
        /** The sampling's ordinal within its session (0-based). */
        readonly tick: number;
        /** Model round-trip INCLUDING the tool handlers that ran inside it. */
        readonly ms: number;
        readonly text: string;
        /** The sampling's thinking trace, when the model produced one. */
        readonly reasoning?: string;
        /** Tool calls the model made this sampling; empty = quiesced. */
        readonly toolCalls: ReadonlyArray<{
          readonly id: string;
          readonly name: string;
          readonly input: unknown;
        }>;
      }
    | {
        readonly type: "tool-result";
        readonly toolCallId: string;
        readonly toolName: string;
        readonly output: unknown;
        readonly isFailure: boolean;
      }
    | {
        /**
         * A DELEGATION left this session: the intrinsic `dispatch` or a
         * policy door (`AI.Dispatch`) handed a task to another agent.
         * Emitted when the handler finishes, so observers can pair the
         * tool call with the worker thread it created (`key` is the
         * child session's key; undefined when the child was minted
         * anonymously).
         */
        readonly type: "dispatched";
        readonly tick: number;
        readonly toolName: string;
        readonly agent: string;
        /** The child session's key; undefined when minted anonymously. */
        readonly child: string | undefined;
      }
    | {
        /**
         * The session QUIESCED with an empty inbox and is parked — its
         * work is done until the world moves (the next input wakes
         * it). The line between "working" and "waiting" for any UI.
         */
        readonly type: "parked";
      }
    | { readonly type: "settled" }
    | {
        /**
         * The current round FAILED. `fatal` distinguishes the two
         * §11b lanes this observation covers: a non-retryable typed
         * failure abandoned on the spot (`fatal: true`) vs a defect
         * the bounded recovery loop will re-enter (`fatal` absent).
         * Rows written before the EncodedCrash shape carry a plain
         * string in `error` — renderers must tolerate both.
         */
        readonly type: "crashed";
        readonly error: EncodedCrash | string;
        readonly fatal?: boolean;
      }
  );

/**
 * The driver's OBSERVABILITY seam — an optional service (the same
 * pattern as the tool engine): when present in the context a driver is
 * interpreted in, every session lifecycle fact is emitted into it;
 * absent, the driver spends nothing. Emission is fire-and-forget —
 * an observer can never fail or slow a session.
 */
export class EventStream extends Context.Service<
  EventStream,
  {
    readonly emit: (observation: SessionObservation) => Effect.Effect<void>;
  }
>()("alchemy/AI/EventStream") {}

/** LIVE observation types — broadcast as they stream but never
 *  persisted, and the seq cursor does not advance for them. */
export const isLiveObservation = (type: SessionObservation["type"]): boolean =>
  type === "assistant-delta" || type === "tool-call";
/** Frames a client sends to an attached session. */
export type SessionSocketClientFrame =
  | {
      /** Replay durable observations with `seq >= fromSeq`, then a
       *  {@link SessionSocketServerFrame} `live` marker. Live broadcast is
       *  independent of subscription — every attached socket receives
       *  new observations; `subscribe` only requests catch-up.
       *  `fromSeq: "live"` skips replay entirely (a client that
       *  hydrated its history from a snapshot wants the tail only). */
      readonly type: "subscribe";
      readonly fromSeq?: number | "live";
    }
  | {
      /** Admit one input to the session (the socket's `steer`). */
      readonly type: "submit";
      readonly input: unknown;
    };

/** Frames a session sends to its attached clients. */
export type SessionSocketServerFrame =
  | {
      readonly type: "observation";
      /**
       * Durable observations are rows — replayable, and the client's
       * cursor advances past them. Live observations (token deltas,
       * in-flight tool calls) are view-only: a reconnect misses them
       * and the durable `assistant` restatement covers the gap.
       */
      readonly durable: boolean;
      readonly observation: SessionObservation;
    }
  | {
      /** Replay complete — delivery is live from here; `seq` is the
       *  next durable cursor. */
      readonly type: "live";
      readonly seq: number;
    };

/**
 * What a driver must expose for one session to speak the socket protocol
 * — the substrate differences (DO storage rows vs in-memory log)
 * disappear behind these three capabilities.
 */
export interface SessionSocketHost {
  /** Durable observations with `seq >= fromSeq`, oldest first. */
  readonly replay: (
    fromSeq: number,
  ) => Effect.Effect<ReadonlyArray<SessionObservation>>;
  /** The next durable seq — what a completed replay reports as `live`. */
  readonly watermark: Effect.Effect<number>;
  /** Admit one input to the session (the socket's steer). */
  readonly submit: (input: unknown) => Effect.Effect<void>;
}

/**
 * The protocol, in one place: both drivers delegate their inbound
 * frames here so the wire can never drift between substrates.
 */
export const handleSessionSocketFrame =
  (
    host: SessionSocketHost,
    send: (frame: SessionSocketServerFrame) => Effect.Effect<void>,
  ) =>
  (frame: SessionSocketClientFrame): Effect.Effect<void> => {
    switch (frame.type) {
      case "subscribe":
        return Effect.gen(function* () {
          const from =
            frame.fromSeq === "live"
              ? yield* host.watermark
              : (frame.fromSeq ?? 0);
          for (const observation of yield* host.replay(from)) {
            yield* send({ type: "observation", durable: true, observation });
          }
          yield* send({ type: "live", seq: yield* host.watermark });
        });
      case "submit":
        return host.submit(frame.input);
      default:
        return Effect.void;
    }
  };

/**
 * The Worker/server-side door to a session's live view: routes an
 * `Upgrade: websocket` request to the session named `term/key`, where the
 * {@link SessionSocketServerFrame} protocol is spoken. Provided BY the
 * driver Layer — `DriverCloudflare` routes into the session's own Durable
 * Object; `DriverCore`'s resident host serves the socket in-process.
 *
 * ```ts
 * const gateway = yield* AI.SessionSockets;
 * // in a fetch handler: ws(s)://host/attach/Scribe/issue-7
 * return yield* gateway.attach("Scribe", "issue-7", request);
 * ```
 */
export class SessionSockets extends Context.Service<
  SessionSockets,
  {
    readonly attach: (
      term: string,
      key: string,
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      never,
      RuntimeContext
    >;
  }
>()("alchemy/AI/SessionSockets") {}

export interface SessionSocketTransportOptions {
  /** The absolute `ws(s)://` URL of the session's attach endpoint. */
  readonly url: string;
  /** Override the WebSocket constructor (defaults to the global). */
  readonly webSocket?: new (url: string) => WebSocket;
  /**
   * What the FIRST subscribe requests:
   *
   * - `"replay"` (default) — the full durable history streams in; for
   *   a client starting from an empty transcript.
   * - `"live"` — tail only; for a client that HYDRATED its transcript
   *   from a snapshot (`/messages`). Replaying over the socket would
   *   duplicate every message the snapshot already delivered.
   *
   * Subsequent subscribes always resume from the cursor.
   */
  readonly history?: "replay" | "live";
}

/**
 * An AI SDK `ChatTransport` over the session socket, for `useChat`:
 *
 * ```ts
 * const chat = useChat({
 *   transport: new SessionSocketTransport({ url: `wss://…/attach/Scribe/${key}` }),
 * });
 * ```
 *
 * `sendMessages` submits the last user message's text and returns a
 * stream of `UIMessageChunk`s translated from the session's observations
 * until the session parks (quiesces), settles, or crashes. Streaming is
 * STEP-granular in v1 — each completed sampling arrives as one burst
 * of chunks (the durable `assistant` restatement); token-level deltas
 * are a translator upgrade, not a protocol change.
 */
export class SessionSocketTransport<
  M extends UIMessage = UIMessage,
> implements ChatTransport<M> {
  private socket: WebSocket | undefined;
  private cursor = 0;
  private subscribed = false;
  private readonly options: SessionSocketTransportOptions;

  constructor(options: SessionSocketTransportOptions) {
    this.options = options;
  }

  private connect(): Promise<WebSocket> {
    if (
      this.socket !== undefined &&
      (this.socket.readyState === 0 || this.socket.readyState === 1)
    ) {
      return this.socket.readyState === 1
        ? Promise.resolve(this.socket)
        : new Promise((resolve, reject) => {
            this.socket!.addEventListener("open", () => resolve(this.socket!));
            this.socket!.addEventListener("error", reject);
          });
    }
    const Ctor = this.options.webSocket ?? WebSocket;
    const socket = new Ctor(this.options.url);
    this.socket = socket;
    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve(socket));
      socket.addEventListener("error", reject);
    });
  }

  /**
   * One turn: translate this session's observations from HERE forward
   * until the translator reports completion. The socket outlives the
   * stream — the next turn reuses it.
   */
  private stream(socket: WebSocket): ReadableStream<UIMessageChunk> {
    const translate = makeChunkTranslator();
    let detach: (() => void) | undefined;
    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        const onMessage = (event: MessageEvent) => {
          const frame = JSON.parse(
            String(event.data),
          ) as SessionSocketServerFrame;
          if (frame.type === "live") {
            // replay complete — pin the cursor to the watermark so the
            // next subscribe never re-reads rows this client (or its
            // hydrating snapshot) has already seen
            this.cursor = Math.max(this.cursor, frame.seq);
            return;
          }
          if (frame.type !== "observation") return;
          if (frame.durable) {
            // DEDUPE by seq: live broadcast is independent of
            // subscription, so a subscribe's replay can re-deliver a
            // row the broadcast already sent (and vice versa). A
            // duplicate row appended twice into one reasoning/text
            // part renders glued, duplicated transcripts.
            if (frame.observation.seq < this.cursor) return;
            this.cursor = frame.observation.seq + 1;
          }
          const { chunks, done } = translate(frame.observation);
          for (const chunk of chunks) controller.enqueue(chunk);
          if (done) {
            detach?.();
            controller.close();
          }
        };
        const onClose = () => {
          detach?.();
          try {
            controller.close();
          } catch {
            // already closed by a terminal observation
          }
        };
        detach = () => {
          socket.removeEventListener("message", onMessage);
          socket.removeEventListener("close", onClose);
        };
        socket.addEventListener("message", onMessage);
        socket.addEventListener("close", onClose, { once: true });
      },
      // `useChat().stop()` cancels the reader — without detaching, the
      // orphaned listener keeps pumping a dead controller and the next
      // stream's frames render nowhere
      cancel: () => {
        detach?.();
      },
    });
  }

  sendMessages: ChatTransport<M>["sendMessages"] = async (options) => {
    const socket = await this.connect();
    const last = options.messages[options.messages.length - 1];
    const text =
      last === undefined
        ? ""
        : last.parts
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n");
    const stream = this.stream(socket);
    socket.send(
      JSON.stringify({
        type: "submit",
        input: text,
      } satisfies SessionSocketClientFrame),
    );
    return stream;
  };

  /**
   * Resume: replay durable observations from the cursor, live-tail on.
   * The FIRST subscribe honors `history` — a snapshot-hydrated client
   * subscribes at the watermark instead of replaying rows it already
   * rendered.
   */
  reconnectToStream: ChatTransport<M>["reconnectToStream"] = async () => {
    const socket = await this.connect();
    const stream = this.stream(socket);
    const fromSeq =
      !this.subscribed && this.options.history === "live"
        ? ("live" as const)
        : this.cursor;
    this.subscribed = true;
    socket.send(
      JSON.stringify({
        type: "subscribe",
        fromSeq,
      } satisfies SessionSocketClientFrame),
    );
    return stream;
  };
}
