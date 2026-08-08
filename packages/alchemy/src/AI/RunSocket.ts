/**
 * The RUN SOCKET protocol — how a live view attaches to one agent run
 * over a WebSocket, and the AI SDK `ChatTransport` that speaks it.
 *
 * Four frame concepts, distilled from studying cloudflare/agents'
 * chat protocol (designs/ai/reports/cloudflare-chat-protocol.md):
 * their five-frame resume handshake, chunk-buffer tables, and
 * full-replay-from-zero all compensate for the absence of a cursor —
 * our observations carry a per-run monotonic `seq`, so resume is ONE
 * frame: `subscribe { fromSeq }` replays the durable observation rows
 * above the cursor and live delivery continues from there.
 *
 * - client → server: {@link RunSocketClientFrame} — `subscribe`
 *   (replay from a cursor) and `submit` (admit input; the answer
 *   arrives as observations, never as a correlated response).
 * - server → client: {@link RunSocketServerFrame} — an `observation`
 *   carrier (durable rows advance the client's cursor; live facts
 *   like `assistant-delta` do not), and a `live` marker ending a
 *   replay.
 *
 * The wire carries DRIVER vocabulary — {@link RunObservation} —
 * not any UI protocol's: translation to AI SDK `UIMessageChunk`s
 * happens client-side ({@link makeChunkTranslator}), so the server
 * never learns about UIMessage.
 */
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { RunObservation } from "./Observer.ts";
import { makeChunkTranslator } from "./UIMessage.ts";

/** Frames a client sends to an attached run. */
export type RunSocketClientFrame =
  | {
      /** Replay durable observations with `seq >= fromSeq`, then a
       *  {@link RunSocketServerFrame} `live` marker. Live broadcast is
       *  independent of subscription — every attached socket receives
       *  new observations; `subscribe` only requests catch-up.
       *  `fromSeq: "live"` skips replay entirely (a client that
       *  hydrated its history from a snapshot wants the tail only). */
      readonly type: "subscribe";
      readonly fromSeq?: number | "live";
    }
  | {
      /** Admit one input to the run (the socket's `steer`). */
      readonly type: "submit";
      readonly input: unknown;
    };

/** Frames a run sends to its attached clients. */
export type RunSocketServerFrame =
  | {
      readonly type: "observation";
      /**
       * Durable observations are rows — replayable, and the client's
       * cursor advances past them. Live observations (token deltas,
       * in-flight tool calls) are view-only: a reconnect misses them
       * and the durable `assistant` restatement covers the gap.
       */
      readonly durable: boolean;
      readonly observation: RunObservation;
    }
  | {
      /** Replay complete — delivery is live from here; `seq` is the
       *  next durable cursor. */
      readonly type: "live";
      readonly seq: number;
    };

/**
 * The LIVE observations — view-only facts that are broadcast but
 * never logged, and whose `seq` repeats the current watermark instead
 * of advancing it: a reconnect misses them and the durable
 * `assistant` restatement covers the gap. The SAME split every
 * projection uses (`ChatsMemory` accumulates exactly these into its
 * transient streaming sample).
 */
export const isLiveObservation = (type: RunObservation["type"]): boolean =>
  type === "assistant-delta" || type === "tool-call";

/**
 * What a driver must expose for one run to speak the socket protocol
 * — the substrate differences (DO storage rows vs in-memory log)
 * disappear behind these three capabilities.
 */
export interface RunSocketHost {
  /** Durable observations with `seq >= fromSeq`, oldest first. */
  readonly replay: (
    fromSeq: number,
  ) => Effect.Effect<ReadonlyArray<RunObservation>>;
  /** The next durable seq — what a completed replay reports as `live`. */
  readonly watermark: Effect.Effect<number>;
  /** Admit one input to the run (the socket's steer). */
  readonly submit: (input: unknown) => Effect.Effect<void>;
}

/**
 * The protocol, in one place: both drivers delegate their inbound
 * frames here so the wire can never drift between substrates.
 */
export const handleRunSocketFrame =
  (
    host: RunSocketHost,
    send: (frame: RunSocketServerFrame) => Effect.Effect<void>,
  ) =>
  (frame: RunSocketClientFrame): Effect.Effect<void> => {
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
 * The Worker/server-side door to a run's live view: routes an
 * `Upgrade: websocket` request to the run named `term/key`, where the
 * {@link RunSocketServerFrame} protocol is spoken. Provided BY the
 * driver Layer — `DriverCloudflare` routes into the run's own Durable
 * Object; `DriverCore`'s resident host serves the socket in-process.
 *
 * ```ts
 * const gateway = yield* AI.AgentGateway;
 * // in a fetch handler: ws(s)://host/attach/Scribe/issue-7
 * return yield* gateway.attach("Scribe", "issue-7", request);
 * ```
 */
export class AgentGateway extends Context.Service<
  AgentGateway,
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
>()("alchemy/AI/AgentGateway") {}

export interface RunSocketTransportOptions {
  /** The absolute `ws(s)://` URL of the run's attach endpoint. */
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
 * An AI SDK `ChatTransport` over the run socket, for `useChat`:
 *
 * ```ts
 * const chat = useChat({
 *   transport: new RunSocketTransport({ url: `wss://…/attach/Scribe/${key}` }),
 * });
 * ```
 *
 * `sendMessages` submits the last user message's text and returns a
 * stream of `UIMessageChunk`s translated from the run's observations
 * until the run parks (quiesces), settles, or crashes. Streaming is
 * STEP-granular in v1 — each completed sampling arrives as one burst
 * of chunks (the durable `assistant` restatement); token-level deltas
 * are a translator upgrade, not a protocol change.
 */
export class RunSocketTransport<
  M extends UIMessage = UIMessage,
> implements ChatTransport<M> {
  private socket: WebSocket | undefined;
  private cursor = 0;
  private subscribed = false;
  private readonly options: RunSocketTransportOptions;

  constructor(options: RunSocketTransportOptions) {
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
   * One turn: translate this run's observations from HERE forward
   * until the translator reports completion. The socket outlives the
   * stream — the next turn reuses it.
   */
  private stream(socket: WebSocket): ReadableStream<UIMessageChunk> {
    const translate = makeChunkTranslator();
    let detach: (() => void) | undefined;
    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        const onMessage = (event: MessageEvent) => {
          const frame = JSON.parse(String(event.data)) as RunSocketServerFrame;
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
      } satisfies RunSocketClientFrame),
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
      } satisfies RunSocketClientFrame),
    );
    return stream;
  };
}
