import * as AI from "alchemy/AI/Client";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import { useSyncExternalStore } from "react";
import { AgentRpcs, type Machine } from "../../src/rpcs.ts";

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:1338";

/** Each session is its own Durable Object, reached over its own WebSocket. */
const socketUrl = (id: string) =>
  `${API_URL.replace(/^http/, "ws")}/agents/${encodeURIComponent(id)}/rpc`;

/**
 * An Effect RPC client for an issue's `AgentRpcs`. The socket
 * protocol is built into the caller's scope, so it lives as long as the
 * session view does (providing it around `RpcClient.make` alone would close
 * the socket as soon as the client is created).
 */
const connect = (id: string) =>
  Effect.gen(function* () {
    const protocol = yield* Layer.build(
      // Effect's default ping timeout (one 5s interval) drops a socket whose call is
      // quiet for 5s, such as a `start` that clones the repository.
      RpcClient.layerProtocolSocket({ retryTransientErrors: true, pingTimeout: "15 seconds" }).pipe(
        Layer.provide(
          Layer.mergeAll(Socket.layerWebSocket(socketUrl(id)), RpcSerialization.layerJson),
        ),
        Layer.provide(Socket.layerWebSocketConstructorGlobal),
      ),
    );
    return yield* RpcClient.make(AgentRpcs).pipe(Effect.provideContext(protocol));
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
    const info = yield* client.start(model ? { sessionId: id, model } : { sessionId: id });
    yield* Deferred.succeed(live.client, client);
    update(id, (s) => ({
      ...s,
      connected: true,
      error: undefined,
      transcript: { ...s.transcript, model: s.transcript.model ?? info.model },
    }));
    yield* Stream.suspend(() =>
      client.events({ sessionId: id, after: live.snapshot.transcript.cursor }),
    ).pipe(
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
    // A prompt starts a stopped machine: show it starting at once.
    if (lastKnown.get(id) === "suspended" && !machineIntent.get(id)) {
      machineIntent.set(id, "starting");
    }
    const queued = !sessions.get(id)?.snapshot.connected;
    if (queued) update(id, (s) => ({ ...s, pending: [...s.pending, text] }));
    return call(id, (c) => c.prompt({ sessionId: id, prompt: text })).finally(() => {
      if (queued) update(id, (s) => ({ ...s, pending: s.pending.filter((p) => p !== text) }));
    });
  },
  steer: (id: string, text: string) => call(id, (c) => c.steer({ sessionId: id, prompt: text })),
  interrupt: (id: string) => call(id, (c) => c.interrupt({ sessionId: id })),
  setModel: (id: string, model: string) => call(id, (c) => c.setModel({ sessionId: id, model })),
  respond: (id: string, requestId: string, answer: AI.Answer) =>
    call(id, (c) => c.respond({ sessionId: id, requestId, answer })),
  /** The session's machine, with live usage when `stats` (and it's running). */
  machine: (id: string, stats = false) => call(id, (c) => c.machine({ sessionId: id, stats })),
  suspend: (id: string) => call(id, (c) => c.suspend({ sessionId: id })),
  resume: (id: string) => call(id, (c) => c.resume({ sessionId: id })),
  /** Works for any session, open in this tab or not (it never starts the machine). */
  settle: (id: string): Promise<Machine> =>
    fetch(`${API_URL}/agents/${encodeURIComponent(id)}/settle`, { method: "POST" }).then((res) =>
      res.ok ? res.json() : res.text().then((text) => Promise.reject(new Error(text))),
    ),
};

//#region sessions

export interface ListedSession {
  readonly id: string;
  /** Its machine: running, suspended, or unknown (unreachable). */
  readonly state: Machine["state"] | "unknown";
  /** Its agent's state (idle, running, …), as last recorded. */
  readonly agent?: AI.SessionInfo["state"];
  readonly costUsd?: number;
  /** When it was settled (archived, its machine stopped). */
  readonly settledAt?: number;
}

/** Every session (newest first), from the server: the same list in any browser. */
export const listSessions = (): Promise<ReadonlyArray<ListedSession>> =>
  fetch(`${API_URL}/agents`).then((res) => (res.ok ? res.json() : []));

//#endregion

//#region machine intents

/**
 * What the user just asked a session's machine to do — shown at once, until
 * the server reports the state it was heading for (or 3 minutes pass).
 */
export type MachineIntent = "starting" | "suspending";

const intents = new Map<string, { readonly state: MachineIntent; readonly at: number }>();
/** The machine state the server last reported, per session. */
const lastKnown = new Map<string, Machine["state"] | "unknown">();
const intentListeners = new Set<() => void>();
const INTENT_MS = 3 * 60_000;

export const machineIntent = {
  set: (id: string, state: MachineIntent) => {
    intents.set(id, { state, at: Date.now() });
    intentListeners.forEach((l) => l());
  },
  /** Drop an intent that won't happen (the request failed). */
  clear: (id: string) => {
    if (intents.delete(id)) intentListeners.forEach((l) => l());
  },
  /** The intent, if the server hasn't caught up with it yet. */
  get: (id: string): MachineIntent | undefined => {
    const intent = intents.get(id);
    return intent && Date.now() - intent.at < INTENT_MS ? intent.state : undefined;
  },
  /** The server reported `state`: drop an intent it fulfils. */
  observe: (id: string, state: Machine["state"] | "unknown") => {
    lastKnown.set(id, state);
    const intent = intents.get(id);
    if (!intent) return;
    const done =
      (intent.state === "suspending" && state === "suspended") ||
      (intent.state === "starting" && state === "running");
    if (done) {
      intents.delete(id);
      intentListeners.forEach((l) => l());
    }
  },
};

/** The machine state to show: a pending intent wins over what the server last said. */
export const useMachineIntent = (id: string) =>
  useSyncExternalStore(
    (listener) => {
      intentListeners.add(listener);
      return () => intentListeners.delete(listener);
    },
    () => machineIntent.get(id),
  );

//#endregion

//#region terminal

/** Keystrokes waiting to be sent, per session: sent one batch at a time, in order. */
const typed = new Map<string, { buffer: string; sending: boolean }>();

const flushInput = (id: string) => {
  const queue = typed.get(id);
  if (!queue || queue.sending || queue.buffer === "") return;
  const data = queue.buffer;
  queue.buffer = "";
  queue.sending = true;
  void call(id, (c) => c.terminalInput({ sessionId: id, data }))
    .catch(() => {})
    .finally(() => {
      queue.sending = false;
      flushInput(id);
    });
};

export const terminal = {
  /**
   * Stream the session's shell to `onData` (its recent output first, then
   * live). `onEnd` runs when the shell exits or the stream fails. Returns a
   * function that stops streaming (the shell keeps running).
   */
  open: (
    id: string,
    size: { readonly cols: number; readonly rows: number },
    onData: (chunk: string) => void,
    onEnd: (reason: string) => void,
  ) => {
    const live = sessions.get(id);
    if (!live) {
      onEnd(`session ${id} is not open`);
      return () => {};
    }
    const fiber = runtime.runFork(
      Effect.flatMap(Deferred.await(live.client), (client) =>
        client
          .terminal({ sessionId: id, ...size })
          .pipe(Stream.runForEach((chunk) => Effect.sync(() => onData(chunk)))),
      ).pipe(
        Effect.matchCause({
          onSuccess: () => onEnd("exited"),
          onFailure: (cause) => onEnd(String(cause)),
        }),
      ),
    );
    return () => void runtime.runFork(Fiber.interrupt(fiber));
  },
  input: (id: string, data: string) => {
    let queue = typed.get(id);
    if (!queue) {
      queue = { buffer: "", sending: false };
      typed.set(id, queue);
    }
    queue.buffer += data;
    flushInput(id);
  },
  resize: (id: string, cols: number, rows: number) =>
    call(id, (c) => c.terminalResize({ sessionId: id, cols, rows })).catch(() => {}),
};

//#endregion

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
