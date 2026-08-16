import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import * as Effect from "effect/Effect";
import type { SessionObservation } from "./Events.ts";
import { makeChunkTranslator } from "./UIMessage.ts";

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
