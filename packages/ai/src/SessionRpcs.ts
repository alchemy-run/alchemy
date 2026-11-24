/**
 * A session as an Effect RPC group: what a browser, or another service, may
 * ask of one session over the network. The module imports nothing a browser
 * cannot bundle.
 *
 * @module
 */
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as RpcWebSocketClient from "alchemy/Workers/RpcWebSocketClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Rpc from "effect/rpc/Rpc";
import type * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import type * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import type { HarnessError } from "./Harness.ts";
import type { NotStarted, Session } from "./Process.ts";
import { HistoryOptions, SessionEvent, SessionPage } from "./Session.ts";

/** The session could not do what it was asked. */
export class SessionError extends Schema.TaggedClass<SessionError>()("SessionError", {
  message: Schema.String,
}) {}

const Message = {
  text: Schema.String,
  /** Makes the message exactly-once: a retry with the same id is not run again. */
  requestId: Schema.optional(Schema.String),
};

/**
 * One session's procedures: the methods of `AI.Session`, with the same
 * names. `events` is a stream. Serve it with {@link SessionHandlers}, and
 * call it with {@link SessionClient}.
 *
 * **Example:** A Durable Object that serves its session
 * ```typescript
 * export default class Agents extends Cloudflare.RpcDurableObject<Agents>()(
 *   "Agents",
 *   { schema: AI.SessionRpcs },
 *   Effect.gen(function* () {
 *     const worker = yield* Worker;
 *     const state = yield* Cloudflare.DurableObjectState;
 *     return Effect.sync(() => AI.SessionHandlers(worker.get(state.id.name ?? "")));
 *   }).pipe(Effect.provide(Live)),
 * ) {}
 * ```
 */
export class SessionRpcs extends RpcGroup.make(
  Rpc.make("send", { payload: Message, error: SessionError }),
  Rpc.make("steer", { payload: Message, error: SessionError }),
  Rpc.make("withdraw", { payload: { id: Schema.String }, error: SessionError }),
  Rpc.make("interrupt", { error: SessionError }),
  Rpc.make("events", {
    payload: { after: Schema.optional(Schema.Number) },
    success: SessionEvent,
    error: SessionError,
    stream: true,
  }),
  Rpc.make("history", { payload: HistoryOptions, success: SessionPage, error: SessionError }),
) {}

const failed = (error: NotStarted | HarnessError) =>
  SessionError.make({
    message:
      error._tag === "NotStarted"
        ? `The ${error.process} session ${error.key} was not started`
        : error.message,
  });

/**
 * The handlers of {@link SessionRpcs} for one session. Return it from an
 * `RpcDurableObject`, which then serves the session over HTTP and over a
 * WebSocket that survives the object sleeping.
 */
export const SessionHandlers = (session: Session) =>
  SessionRpcs.toLayer({
    send: ({ text, requestId }) =>
      session
        .send(text, requestId === undefined ? {} : { requestId })
        .pipe(Effect.mapError(failed)),
    steer: ({ text, requestId }) =>
      session
        .steer(text, requestId === undefined ? {} : { requestId })
        .pipe(Effect.mapError(failed)),
    withdraw: ({ id }) => session.withdraw(id).pipe(Effect.mapError(failed)),
    interrupt: () => session.interrupt.pipe(Effect.mapError(failed)),
    events: ({ after }) =>
      session.events(after === undefined ? {} : { after }).pipe(Stream.mapError(failed)),
    history: (options) => session.history(options).pipe(Effect.mapError(failed)),
  }) satisfies Layer.Layer<Rpc.ToHandler<RpcGroup.Rpcs<typeof SessionRpcs>>, never, RuntimeContext>;

/** A client of one session, wherever it is served. */
export class SessionClient extends Context.Service<
  SessionClient,
  RpcClient.FromGroup<typeof SessionRpcs, RpcClientError>
>()("@alchemy.run/ai/SessionClient") {}

/**
 * A {@link SessionClient} over one WebSocket, open for as long as the Layer
 * is. `url` is the route your Worker forwards to the session's object.
 *
 * **Example:** In a browser
 * ```typescript
 * const SessionLive = AI.SessionClientWebSocket(`wss://${location.host}/sessions/${id}`).pipe(
 *   Layer.provide(Socket.layerWebSocketConstructorGlobal),
 * );
 * ```
 */
export const SessionClientWebSocket = (
  url: string,
): Layer.Layer<SessionClient, never, Socket.WebSocketConstructor> =>
  RpcWebSocketClient.layer(SessionClient, SessionRpcs, url);

/**
 * A session's events for as long as you read them: its status, every item
 * after `after`, then what happens next. When the connection drops, or the
 * object that serves the session wakes from sleep, it asks again from the
 * last item it delivered, so no item is missed or repeated.
 */
export const followSession = (options?: {
  readonly after?: number;
}): Stream.Stream<SessionEvent, SessionError, SessionClient> =>
  Stream.suspend(() => {
    let after = options?.after;
    const read = (): Stream.Stream<SessionEvent, SessionError, SessionClient> =>
      Stream.unwrap(
        Effect.map(SessionClient, (client) => client.events(after === undefined ? {} : { after })),
      ).pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            if (event.type === "item") after = event.seq;
          }),
        ),
        // A lost connection is read again from the last item; the session's own failure is not.
        Stream.catchTag("RpcClientError", () =>
          Stream.flatMap(Stream.fromEffect(Effect.sleep("1 second")), read),
        ),
      );
    return read();
  });
