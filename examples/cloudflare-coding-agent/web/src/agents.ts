import * as AI from "alchemy/AI/Client";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import { useSyncExternalStore } from "react";

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:1338";

/** Each session is its own Durable Object, reached over its own WebSocket. */
const socketUrl = (id: string) =>
  `${API_URL.replace(/^http/, "ws")}/agents/${encodeURIComponent(id)}/rpc`;

/**
 * An Effect RPC client for one session's `AI.SessionRpcs`. The socket
 * protocol is built into the caller's scope, so it lives as long as the
 * session view does (providing it around `RpcClient.make` alone would close
 * the socket as soon as the client is created).
 */
const connect = (id: string) =>
  Effect.gen(function* () {
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
        Layer.provide(
          Layer.mergeAll(Socket.layerWebSocket(socketUrl(id)), RpcSerialization.layerJson),
        ),
        Layer.provide(Socket.layerWebSocketConstructorGlobal),
      ),
    );
    return yield* RpcClient.make(AI.SessionRpcs).pipe(Effect.provideContext(protocol));
  });

type Client = Effect.Success<ReturnType<typeof connect>>;

const runtime = ManagedRuntime.make(Layer.empty);

export interface SessionSnapshot {
  readonly transcript: AI.Transcript;
  readonly connected: boolean;
  readonly error: string | undefined;
  /** Prompts sent before the session connected, shown until they land in its log. */
  readonly pending: ReadonlyArray<string>;
}

interface Live {
  snapshot: SessionSnapshot;
  /** Resolves once the session is connected and started. */
  client: Deferred.Deferred<Client>;
  scope: Scope.Closeable;
}

const sessions = new Map<string, Live>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

const update = (id: string, f: (s: SessionSnapshot) => SessionSnapshot) => {
  const live = sessions.get(id);
  if (!live) return;
  live.snapshot = f(live.snapshot);
  notify();
};

const initial: SessionSnapshot = {
  transcript: AI.emptyTranscript,
  connected: false,
  error: undefined,
  pending: [],
};

/**
 * Open a session (idempotent): connect, `start` it (creates the session in
 * its container on first use), then fold its event log — replay, then live —
 * into a transcript. A dropped stream resumes from the last cursor.
 */
const open = (id: string, model: string | undefined) => {
  if (sessions.has(id)) return;
  const scope = runtime.runSync(Scope.make());
  const live: Live = { snapshot: initial, client: runtime.runSync(Deferred.make<Client>()), scope };
  sessions.set(id, live);
  const program = Effect.gen(function* () {
    const client = yield* connect(id);
    const info = yield* client.start(model ? { model } : {});
    yield* Deferred.succeed(live.client, client);
    update(id, (s) => ({
      ...s,
      connected: true,
      error: undefined,
      transcript: { ...s.transcript, model: s.transcript.model ?? info.model },
    }));
    yield* Stream.suspend(() => client.events({ after: live.snapshot.transcript.cursor })).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() =>
          update(id, (s) => ({ ...s, transcript: AI.reduceTranscript(s.transcript, event) })),
        ),
      ),
      Effect.tapError((e) =>
        Effect.sync(() => update(id, (s) => ({ ...s, connected: false, error: String(e) }))),
      ),
      Effect.retry(Schedule.spaced("2 seconds")),
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => update(id, (s) => ({ ...s, connected: false, error: String(cause) }))),
    ),
    Effect.provideService(Scope.Scope, scope),
  );
  runtime.runFork(program);
};

/**
 * Run one session operation with its client — waiting for the session to
 * connect first, so a prompt sent while its container cold-starts is not lost.
 */
const call = <A>(id: string, f: (client: Client) => Effect.Effect<A, unknown>) => {
  const live = sessions.get(id);
  if (!live) return Promise.reject(new Error(`session ${id} is not open`));
  return runtime.runPromise(Effect.flatMap(Deferred.await(live.client), f)).catch((e: unknown) => {
    update(id, (s) => ({ ...s, error: String(e) }));
    throw e;
  });
};

export const agents = {
  open,
  close: (id: string) => {
    const live = sessions.get(id);
    if (!live) return;
    sessions.delete(id);
    notify();
    void runtime.runPromise(Scope.close(live.scope, Exit.void));
  },
  prompt: (id: string, text: string) => {
    const queued = !sessions.get(id)?.snapshot.connected;
    if (queued) update(id, (s) => ({ ...s, pending: [...s.pending, text] }));
    return call(id, (c) => c.prompt({ prompt: text })).finally(() => {
      if (queued) update(id, (s) => ({ ...s, pending: s.pending.filter((p) => p !== text) }));
    });
  },
  steer: (id: string, text: string) => call(id, (c) => c.steer({ prompt: text })),
  interrupt: (id: string) => call(id, (c) => c.interrupt()),
  setModel: (id: string, model: string) => call(id, (c) => c.setModel({ model })),
  respond: (id: string, requestId: string, answer: AI.Answer) =>
    call(id, (c) => c.respond({ requestId, answer })),
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** A session's live snapshot (opens it on first use). */
export const useSession = (id: string): SessionSnapshot =>
  useSyncExternalStore(subscribe, () => sessions.get(id)?.snapshot ?? initial);

/** Snapshots of every open session, for the sidebar. */
export const useSnapshot = (id: string): SessionSnapshot | undefined =>
  useSyncExternalStore(subscribe, () => sessions.get(id)?.snapshot);
