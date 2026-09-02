import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import * as Effect from "effect/Effect";
import type { SessionObservation } from "./Events.ts";
import { inputToUIMessage, makeChunkTranslator } from "./UIMessage.ts";

/**
 * Frames a client sends to an attached session — one half of the
 * SESSION SOCKET, the wire under `Sessions.attach`: one bidirectional
 * protocol for a session's live view (replay durable observations
 * from a cursor, tail live ones, submit inputs back), spoken
 * identically by every placement. The server half
 * ({@link handleSessionSocketFrame} over a {@link SessionSocketHost})
 * keeps the wire from drifting between substrates; the client half
 * ({@link SessionSocketTransport}) adapts it to the AI SDK's
 * `ChatTransport` for `useChat`.
 */
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
 * One AI SDK stream in flight over the socket: a translator plus the
 * controller that receives its chunks. `kind` decides who is the SINK
 * (see {@link SessionSocketTransport}).
 */
interface Turn {
  readonly kind: "submit" | "resume";
  readonly translate: ReturnType<typeof makeChunkTranslator>;
  readonly controller: ReadableStreamDefaultController<UIMessageChunk>;
  /** The translator has opened an assistant message — chunks are
   *  mid-flight, so a user message must not be spliced under them. */
  started: boolean;
  open: boolean;
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
 *
 * ONE socket, ONE listener, ONE sink. The AI SDK keeps several streams
 * pending at once — `useChat({ resume })` holds a resume stream open
 * for the live tail while `sendMessage` opens a second for the turn —
 * and all of them would hear the same frames. Every frame therefore
 * goes to exactly one turn, the SINK: the newest open submit (a turn
 * the user is waiting on), else the newest resume (the tail). The
 * others stay pending, unfed, until the SDK cancels them (the next
 * resume aborts the previous) or the socket closes. Frames arriving
 * with NO sink are dropped without advancing the cursor — the next
 * subscribe replays them.
 *
 * The AI SDK's wire protocol has no user message: `input`
 * observations (a replayed history, a steer from another client, a
 * note the driver appended) are surfaced through {@link onInput}
 * instead, as the `UIMessage` a snapshot would have produced (same
 * `u-${seq}` id, so the two dedupe). The echo of THIS client's own
 * submit is swallowed — `useChat` already appended it.
 */
export class SessionSocketTransport<
  M extends UIMessage = UIMessage,
> implements ChatTransport<M> {
  private socket: WebSocket | undefined;
  private cursor = 0;
  private subscribed = false;
  private readonly options: SessionSocketTransportOptions;
  private turns: Turn[] = [];
  /** Text of the submit whose `input` echo hasn't come back yet. */
  private pendingSubmit: string | undefined;
  /** Inputs that landed mid-burst — delivered when the burst ends. */
  private heldInputs: UIMessage[] = [];
  /**
   * Receives user messages the wire carried — see the class doc. Set
   * by `useChat` (`alchemy/AI/React`); a bare transport drops them.
   */
  onInput: ((message: UIMessage) => void) | undefined;

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
    socket.addEventListener("message", (event) =>
      this.onFrame(JSON.parse(String(event.data)) as SessionSocketServerFrame),
    );
    socket.addEventListener(
      "close",
      () => {
        // every pending turn ends — the SDK reports each as done, and
        // the persistent view re-subscribes over a fresh socket from
        // the cursor
        if (this.socket === socket) this.socket = undefined;
        for (const turn of this.turns.splice(0)) this.end(turn);
      },
      { once: true },
    );
    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve(socket));
      socket.addEventListener("error", reject);
    });
  }

  private sink(): Turn | undefined {
    const open = this.turns.filter((turn) => turn.open);
    return open.filter((turn) => turn.kind === "submit").at(-1) ?? open.at(-1);
  }

  private end(turn: Turn): void {
    if (!turn.open) return;
    turn.open = false;
    try {
      turn.controller.close();
    } catch {
      // already closed by a terminal observation
    }
    this.turns = this.turns.filter((candidate) => candidate !== turn);
  }

  private onFrame(frame: SessionSocketServerFrame): void {
    const sink = this.sink();
    // nobody listening: leave the cursor where it is so the next
    // subscribe replays from here — nothing is lost, only deferred
    if (sink === undefined) return;
    if (frame.type === "live") {
      // replay complete — pin the cursor to the watermark so the next
      // subscribe never re-reads rows this client (or its hydrating
      // snapshot) has already seen
      this.cursor = Math.max(this.cursor, frame.seq);
      return;
    }
    if (frame.type !== "observation") return;
    if (frame.durable) {
      // DEDUPE by seq: live broadcast is independent of subscription,
      // so a subscribe's replay can re-deliver a row the broadcast
      // already sent (and vice versa)
      if (frame.observation.seq < this.cursor) return;
      this.cursor = frame.observation.seq + 1;
    }
    const observation = frame.observation;
    if (observation.type === "input") {
      if (
        this.pendingSubmit !== undefined &&
        observation.text === this.pendingSubmit &&
        observation.kind === undefined
      ) {
        this.pendingSubmit = undefined;
        return;
      }
      const message = inputToUIMessage(observation);
      if (sink.started) this.heldInputs.push(message);
      else this.onInput?.(message);
      return;
    }
    const { chunks, done } = sink.translate(observation);
    if (chunks.length > 0) sink.started = true;
    for (const chunk of chunks) sink.controller.enqueue(chunk);
    if (done) {
      this.end(sink);
      for (const message of this.heldInputs.splice(0)) this.onInput?.(message);
    }
  }

  /**
   * One turn: translate this session's observations from HERE forward
   * until the translator reports completion. The socket outlives the
   * stream — the next turn reuses it.
   */
  private stream(kind: Turn["kind"]): ReadableStream<UIMessageChunk> {
    let turn: Turn | undefined;
    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        turn = {
          kind,
          translate: makeChunkTranslator(),
          controller,
          started: false,
          open: true,
        };
        // a submit supersedes any earlier submit still waiting: the
        // sink is the newest, and the older one ends (empty) rather
        // than hanging the SDK's request forever
        if (kind === "submit") {
          for (const earlier of this.turns.filter(
            (candidate) => candidate.kind === "submit",
          )) {
            this.end(earlier);
          }
        }
        this.turns.push(turn);
      },
      // `useChat().stop()` — or the SDK aborting a superseded resume —
      // cancels the reader; the turn leaves the sink election so the
      // next frames go to whoever is left
      cancel: () => {
        if (turn !== undefined) {
          turn.open = false;
          this.turns = this.turns.filter((candidate) => candidate !== turn);
        }
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
    const stream = this.stream("submit");
    this.pendingSubmit = text;
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
    const stream = this.stream("resume");
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
