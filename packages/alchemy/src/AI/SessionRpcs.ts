import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  Answer,
  Capabilities,
  Cursor,
  Prompt,
  SessionError,
  SessionEvent,
  SessionInfo,
  StartSession,
  TurnInfo,
  TurnResult,
  Unsupported,
  type Harness,
  type Session,
} from "./Session.ts";

const SessionFailure = Schema.Union([SessionError, Unsupported]);

/**
 * The standard per-session RPC contract — one session per server instance
 * (e.g. a Durable Object whose name IS the session id). Serve it with
 * {@link makeSessionHandlers}; merge your own RPCs into it with `.merge(...)`.
 *
 * A standard contract is what lets shared UIs and clients (React hooks, a
 * desktop app) drive any user-built session host.
 *
 * @example
 * ```typescript
 * export class Agent extends Cloudflare.RpcDurableObject<Agent>()("Agent", {
 *   schema: AI.SessionRpcs,
 * }) {}
 * ```
 */
export class SessionRpcs extends RpcGroup.make(
  Rpc.make("start", { payload: StartSession, success: SessionInfo, error: SessionFailure }),
  Rpc.make("prompt", { payload: { prompt: Prompt }, success: TurnInfo, error: SessionFailure }),
  Rpc.make("steer", { payload: { prompt: Prompt }, error: SessionFailure }),
  Rpc.make("interrupt", { error: SessionFailure }),
  Rpc.make("setModel", { payload: { model: Schema.String }, error: SessionFailure }),
  Rpc.make("respond", {
    payload: { requestId: Schema.String, answer: Answer },
    error: SessionFailure,
  }),
  Rpc.make("result", {
    payload: { turnId: Schema.optional(Schema.String) },
    success: TurnResult,
    error: SessionFailure,
  }),
  Rpc.make("events", {
    payload: { after: Schema.optional(Cursor) },
    success: SessionEvent,
    error: SessionFailure,
    stream: true,
  }),
  Rpc.make("info", { success: SessionInfo, error: SessionFailure }),
  Rpc.make("close", { error: SessionFailure }),
) {}

/**
 * The multi-session contract a harness server exposes (e.g. from inside a
 * container): every call names its session. {@link serveHarness} implements
 * it over a {@link Harness}; {@link remoteHarness} turns a client back into
 * one.
 */
export class HarnessRpcs extends RpcGroup.make(
  Rpc.make("describe", {
    success: Schema.Struct({ name: Schema.String, capabilities: Capabilities }),
  }),
  Rpc.make("start", { payload: StartSession, success: SessionInfo, error: SessionFailure }),
  Rpc.make("list", { success: Schema.Array(SessionInfo), error: SessionFailure }),
  Rpc.make("prompt", {
    payload: { sessionId: Schema.String, prompt: Prompt },
    success: TurnInfo,
    error: SessionFailure,
  }),
  Rpc.make("steer", {
    payload: { sessionId: Schema.String, prompt: Prompt },
    error: SessionFailure,
  }),
  Rpc.make("interrupt", { payload: { sessionId: Schema.String }, error: SessionFailure }),
  Rpc.make("setModel", {
    payload: { sessionId: Schema.String, model: Schema.String },
    error: SessionFailure,
  }),
  Rpc.make("respond", {
    payload: { sessionId: Schema.String, requestId: Schema.String, answer: Answer },
    error: SessionFailure,
  }),
  Rpc.make("result", {
    payload: { sessionId: Schema.String, turnId: Schema.optional(Schema.String) },
    success: TurnResult,
    error: SessionFailure,
  }),
  Rpc.make("events", {
    payload: { sessionId: Schema.String, after: Schema.optional(Cursor) },
    success: SessionEvent,
    error: SessionFailure,
    stream: true,
  }),
  Rpc.make("info", {
    payload: { sessionId: Schema.String },
    success: SessionInfo,
    error: SessionFailure,
  }),
  Rpc.make("fork", {
    payload: { sessionId: Schema.String },
    success: SessionInfo,
    error: SessionFailure,
  }),
  Rpc.make("close", { payload: { sessionId: Schema.String }, error: SessionFailure }),
) {}

/**
 * {@link SessionRpcs} handlers for the session `id` on `harness` — a pure
 * mapping onto the {@link Session} methods. `start` creates the session
 * under `id` (idempotent); every other call resolves it.
 *
 * `harness` may be an Effect, resolved on every call in the call's own
 * scope. Use that form whenever reaching the harness does I/O (connecting to
 * a container): a Durable Object must not do I/O while it is constructed.
 */
export const makeSessionHandlers = <R = never>(options: {
  readonly harness: Harness | Effect.Effect<Harness, SessionError, R | Scope.Scope>;
  readonly id: string;
}) => {
  const { id } = options;
  const harness: Effect.Effect<Harness, SessionError, R | Scope.Scope> = Effect.isEffect(
    options.harness,
  )
    ? options.harness
    : Effect.succeed(options.harness);
  const session = Effect.flatMap(harness, (h) => h.get(id));
  const call = <A, E, R2>(f: (s: Session) => Effect.Effect<A, E, R2>) =>
    Effect.scoped(Effect.flatMap(session, f));
  return SessionRpcs.toLayer({
    start: (opts) =>
      Effect.scoped(
        harness.pipe(
          Effect.flatMap((h) => h.start({ ...opts, id })),
          Effect.flatMap((s) => s.info()),
        ),
      ),
    prompt: ({ prompt }) => call((s) => s.prompt(prompt)),
    steer: ({ prompt }) => call((s) => s.steer(prompt)),
    interrupt: () => call((s) => s.interrupt()),
    setModel: ({ model }) => call((s) => s.setModel(model)),
    respond: ({ requestId, answer }) => call((s) => s.respond(requestId, answer)),
    result: ({ turnId }) => call((s) => s.result(turnId)),
    events: ({ after }) =>
      Stream.unwrap(Effect.map(session, (s) => s.events({ after }))).pipe(Stream.scoped),
    info: () => call((s) => s.info()),
    close: () => call((s) => s.close()),
  });
};

/** {@link HarnessRpcs} handlers over a {@link Harness}. */
export const serveHarness = (harness: Harness) => {
  const get = (sessionId: string) => harness.get(sessionId);
  return HarnessRpcs.toLayer({
    describe: () => Effect.succeed({ name: harness.name, capabilities: harness.capabilities }),
    start: (opts) => harness.start(opts).pipe(Effect.flatMap((s) => s.info())),
    list: () => harness.list(),
    prompt: ({ sessionId, prompt }) => Effect.flatMap(get(sessionId), (s) => s.prompt(prompt)),
    steer: ({ sessionId, prompt }) => Effect.flatMap(get(sessionId), (s) => s.steer(prompt)),
    interrupt: ({ sessionId }) => Effect.flatMap(get(sessionId), (s) => s.interrupt()),
    setModel: ({ sessionId, model }) => Effect.flatMap(get(sessionId), (s) => s.setModel(model)),
    respond: ({ sessionId, requestId, answer }) =>
      Effect.flatMap(get(sessionId), (s) => s.respond(requestId, answer)),
    result: ({ sessionId, turnId }) => Effect.flatMap(get(sessionId), (s) => s.result(turnId)),
    events: ({ sessionId, after }) =>
      Stream.unwrap(Effect.map(get(sessionId), (s) => s.events({ after }))),
    info: ({ sessionId }) => Effect.flatMap(get(sessionId), (s) => s.info()),
    fork: ({ sessionId }) =>
      Effect.flatMap(get(sessionId), (s) => s.fork()).pipe(Effect.flatMap((f) => f.info())),
    close: ({ sessionId }) => Effect.flatMap(get(sessionId), (s) => s.close()),
  });
};

type HarnessClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof HarnessRpcs>, any>;

const transportError = (sessionId?: string) => (cause: unknown) =>
  cause instanceof SessionError || cause instanceof Unsupported
    ? (cause as SessionError)
    : new SessionError({ sessionId, message: `harness transport failed: ${String(cause)}` });

/**
 * A {@link Harness} backed by a {@link HarnessRpcs} client — how code
 * outside the sandbox (a Worker, a Durable Object) drives a harness server
 * running inside it.
 */
export const remoteHarness = (client: HarnessClient): Effect.Effect<Harness, SessionError> =>
  Effect.gen(function* () {
    const { name, capabilities } = yield* client
      .describe(undefined as never)
      .pipe(Effect.mapError(transportError()));
    const sessionFor = (info: SessionInfo): Session => {
      const sessionId = info.id;
      const lift = <A>(effect: Effect.Effect<A, unknown>) =>
        effect.pipe(Effect.mapError(transportError(sessionId))) as Effect.Effect<A, SessionError>;
      // Keep `Unsupported` typed across the wire (callers branch on it).
      const liftUnsupported = <A>(effect: Effect.Effect<A, unknown>) =>
        effect.pipe(
          Effect.mapError((e) => (e instanceof Unsupported ? e : transportError(sessionId)(e))),
        ) as Effect.Effect<A, SessionError | Unsupported>;
      return {
        id: sessionId,
        harness: name,
        capabilities,
        prompt: (prompt) => lift(client.prompt({ sessionId, prompt })),
        steer: (prompt) => lift(client.steer({ sessionId, prompt })),
        interrupt: () => lift(client.interrupt({ sessionId })),
        setModel: (model) => liftUnsupported(client.setModel({ sessionId, model })),
        respond: (requestId, answer) => lift(client.respond({ sessionId, requestId, answer })),
        result: (turnId) => lift(client.result({ sessionId, turnId })),
        events: (options) =>
          client
            .events({ sessionId, after: options?.after })
            .pipe(Stream.mapError(transportError(sessionId))) as Stream.Stream<
            SessionEvent,
            SessionError
          >,
        info: () => lift(client.info({ sessionId })),
        fork: () => lift(client.fork({ sessionId })).pipe(Effect.map(sessionFor)),
        close: () => lift(client.close({ sessionId })),
      };
    };
    return {
      name,
      capabilities,
      start: (options) =>
        client.start(options ?? {}).pipe(Effect.mapError(transportError()), Effect.map(sessionFor)),
      get: (id) =>
        client
          .info({ sessionId: id })
          .pipe(Effect.mapError(transportError(id)), Effect.map(sessionFor)),
      list: () => client.list(undefined as never).pipe(Effect.mapError(transportError())),
    } satisfies Harness;
  });

/**
 * Follow a session's events across disconnects: re-open from the last seen
 * cursor whenever the stream fails (e.g. a hibernating Durable Object closing
 * its socket with 1012). Completes when the session closes.
 */
export const followEvents = <E, R>(
  open: (after: Cursor | undefined) => Stream.Stream<SessionEvent, E, R>,
  options?: { readonly after?: Cursor; readonly retries?: number },
): Stream.Stream<SessionEvent, E, R> =>
  Stream.suspend(() => {
    let last = options?.after;
    return Stream.suspend(() => open(last)).pipe(
      Stream.tap((event) => Effect.sync(() => void (last = event.cursor))),
      Stream.retry(
        // Exponential backoff capped at 5s, at most `retries` re-opens.
        Schedule.min([Schedule.exponential("250 millis"), Schedule.spaced("5 seconds")]).pipe(
          Schedule.upTo({ times: options?.retries ?? 10 }),
        ),
      ),
    ) as Stream.Stream<SessionEvent, E, R>;
  });

/**
 * Connect to a harness served with `AI.serveHarnessHttp` through any
 * `HttpClient` — e.g. a container port from a Durable Object
 * (`Cloudflare.toHttpClient(yield* sandbox.getTcpPort(3000))`). The client
 * lives in the ambient `Scope`.
 */
export const connectHarness = (
  httpClient: HttpClient.HttpClient,
  options?: { readonly url?: string },
): Effect.Effect<Harness, SessionError, Scope.Scope> =>
  RpcClient.make(HarnessRpcs).pipe(
    Effect.provide(
      RpcClient.layerProtocolHttp({ url: options?.url ?? "http://harness/" }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HttpClient.HttpClient, httpClient),
            RpcSerialization.layerNdjson,
          ),
        ),
      ),
    ),
    Effect.flatMap(remoteHarness),
  );
