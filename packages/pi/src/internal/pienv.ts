/**
 * A pi-env connection over any byte stream: the same framed protocol as
 * `@earendil-works/pi-env`'s `Connection`, but the daemon is started by
 * whoever owns the transport (a sandbox's process API) instead of a local
 * `child_process`. `RemoteExecutionEnv` drives it exactly as it drives
 * pi-env's own connection.
 *
 * @internal
 */
import {
  RemoteError,
  type RemoteInfo,
  type Reply,
  type RequestOptions,
} from "@earendil-works/pi-env";

type Json = Record<string, unknown>;

const REQUEST = 1;
const RESULT = 2;
const ERROR = 3;
const EVENT = 4;
const CANCEL = 5;
const PING = 6;
const MAX_FRAME = 16 * 1024 * 1024;
const PING_INTERVAL_MS = 5_000;
const START_TIMEOUT_MS = 60_000;

/** A started daemon: its stdin, and callbacks for its stdout and its end. */
export interface DaemonPipe {
  readonly write: (bytes: Uint8Array) => void;
  readonly close: () => void;
}

/**
 * Start `pi-env serve --token <token>` somewhere and connect its stdout to
 * `onData`. Called again after the connection is lost or closed.
 */
export type OpenDaemon = (
  token: string,
  handlers: { readonly onData: (bytes: Uint8Array) => void; readonly onClose: () => void },
) => Promise<DaemonPipe>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const wellFormed = (_key: string, value: unknown) =>
  typeof value === "string"
    ? ((value as { toWellFormed?: () => string }).toWellFormed?.() ?? value)
    : value;

const frame = (type: number, id: number, json: Json, payload: Uint8Array = new Uint8Array(0)) => {
  const body = encoder.encode(JSON.stringify(json, wellFormed));
  const out = new Uint8Array(13 + body.length + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 9 + body.length + payload.length);
  view.setUint8(4, type);
  view.setUint32(5, id);
  view.setUint32(9, body.length);
  out.set(body, 13);
  out.set(payload, 13 + body.length);
  return out;
};

const lost = (message: string) => new RemoteError({ code: "unknown", message, lost: true });

const randomToken = () =>
  [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

interface Pending {
  readonly resolve: (reply: Reply) => void;
  readonly reject: (error: unknown) => void;
  readonly onEvent?: (json: Json, payload: Uint8Array) => void;
}

class Session {
  readonly pending = new Map<number, Pending>();
  buffer = new Uint8Array(0);
  synced = false;
  live = true;
  pipe: DaemonPipe | undefined;
  timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    readonly id: number,
    readonly token: string,
  ) {}
}

/**
 * The public surface `RemoteExecutionEnv` uses (`info`, `session`,
 * `request`, `close`, `kill`), over a daemon {@link OpenDaemon} starts.
 * It closes itself once no request has been in flight for `idleMs`, so a
 * daemon never outlives the work that needed it; the next request starts
 * a new one.
 */
export class StreamConnection {
  #open: OpenDaemon;
  #idleMs: number;
  #session: Session | undefined;
  #ready: Promise<{ info: RemoteInfo; session: Session }> | undefined;
  #sessions = 0;
  #nextId = 1;
  #closed = false;
  #idle: ReturnType<typeof setTimeout> | undefined;

  constructor(open: OpenDaemon, options: { readonly idleMs?: number } = {}) {
    this.#open = open;
    this.#idleMs = options.idleMs ?? 10_000;
  }

  async info(): Promise<RemoteInfo> {
    return (await this.#connect()).info;
  }

  async session(): Promise<number> {
    return (await this.#connect()).session.id;
  }

  async request(op: string, json: Json, options: RequestOptions = {}): Promise<Reply> {
    if (options.session !== undefined) {
      const current = this.#session;
      if (current === undefined || current.id !== options.session || !current.live) {
        throw lost("pi-env connection lost");
      }
      return this.#send(current, op, json, options);
    }
    const { session } = await this.#connect();
    return this.#send(session, op, json, options);
  }

  close(): void {
    this.#closed = true;
    if (this.#session)
      this.#teardown(
        this.#session,
        new RemoteError({ code: "unknown", message: "Connection closed" }),
      );
  }

  kill(id: number, session: number): void {
    const current = this.#session;
    if (current?.id === session && current.live)
      current.pipe?.write(frame(CANCEL, id, { mode: "kill" }));
  }

  #connect() {
    if (this.#closed)
      return Promise.reject(new RemoteError({ code: "unknown", message: "Connection closed" }));
    if (this.#ready === undefined) {
      const ready = this.#start();
      this.#ready = ready;
      ready.catch(() => {
        if (this.#ready === ready) this.#ready = undefined;
      });
    }
    return this.#ready;
  }

  #send(session: Session, op: string, json: Json, options: RequestOptions): Promise<Reply> {
    if (!session.live) return Promise.reject(lost("pi-env connection lost"));
    clearTimeout(this.#idle);
    const id = this.#nextId++;
    return new Promise<Reply>((resolve, reject) => {
      const onAbort = () => session.pipe?.write(frame(CANCEL, id, {}));
      const done = () => {
        options.signal?.removeEventListener("abort", onAbort);
        if (session.pending.size === 0) this.#armIdle(session);
      };
      session.pending.set(id, {
        resolve: (reply) => {
          session.pending.delete(id);
          done();
          resolve(reply);
        },
        reject: (error) => {
          session.pending.delete(id);
          done();
          reject(error);
        },
        ...(options.onEvent ? { onEvent: options.onEvent as Pending["onEvent"] } : {}),
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      options.onStart?.(id, session.id);
      session.pipe?.write(frame(REQUEST, id, { ...json, op }, options.payload));
      if (options.signal?.aborted) onAbort();
    });
  }

  #armIdle(session: Session) {
    clearTimeout(this.#idle);
    this.#idle = setTimeout(() => {
      if (session.pending.size === 0) this.#teardown(session, lost("pi-env connection idle"));
    }, this.#idleMs);
  }

  async #start(): Promise<{ info: RemoteInfo; session: Session }> {
    const session = new Session(++this.#sessions, randomToken());
    this.#session = session;
    session.pipe = await this.#open(session.token, {
      onData: (bytes) => this.#onData(session, bytes),
      onClose: () => this.#teardown(session, lost("pi-env exited")),
    }).catch((error: unknown) => {
      session.live = false;
      throw new RemoteError({ code: "spawn_error", message: String(error), lost: true });
    });
    session.timer = setInterval(() => session.pipe?.write(frame(PING, 0, {})), PING_INTERVAL_MS);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const { json } = await Promise.race([
        this.#send(session, "hello", { protocol: 1 }, {}),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(lost(`pi-env did not answer within ${START_TIMEOUT_MS / 1000} s`)),
            START_TIMEOUT_MS,
          );
        }),
      ]);
      if (json.protocol !== 1) throw lost(`Unsupported pi-env protocol ${String(json.protocol)}`);
      return { info: json as unknown as RemoteInfo, session };
    } catch (error) {
      this.#teardown(session, error);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  #teardown(session: Session, error: unknown) {
    if (!session.live) return;
    session.live = false;
    clearInterval(session.timer);
    if (this.#session === session) {
      this.#session = undefined;
      this.#ready = undefined;
    }
    session.pipe?.close();
    const pending = [...session.pending.values()];
    session.pending.clear();
    for (const request of pending) request.reject(error);
  }

  #onData(session: Session, chunk: Uint8Array) {
    if (!session.live) return;
    const merged = new Uint8Array(session.buffer.length + chunk.length);
    merged.set(session.buffer);
    merged.set(chunk, session.buffer.length);
    session.buffer = merged;
    if (!session.synced) {
      const marker = encoder.encode(`PI-ENV ${session.token}\n`);
      const index = indexOf(session.buffer, marker);
      if (index === -1) return;
      session.buffer = session.buffer.subarray(index + marker.length);
      session.synced = true;
    }
    while (session.live && session.buffer.length >= 4) {
      const view = new DataView(
        session.buffer.buffer,
        session.buffer.byteOffset,
        session.buffer.byteLength,
      );
      const length = view.getUint32(0);
      if (length < 9 || length > MAX_FRAME)
        return this.#teardown(session, lost("Corrupt frame from pi-env"));
      if (session.buffer.length < 4 + length) return;
      const type = view.getUint8(4);
      const id = view.getUint32(5);
      const jsonLength = view.getUint32(9);
      let json: Json;
      try {
        json = JSON.parse(decoder.decode(session.buffer.subarray(13, 13 + jsonLength))) as Json;
      } catch {
        return this.#teardown(session, lost("Corrupt frame from pi-env"));
      }
      const payload = session.buffer.slice(13 + jsonLength, 4 + length);
      session.buffer = session.buffer.subarray(4 + length);
      const pending = session.pending.get(id);
      if (type === EVENT) pending?.onEvent?.(json, payload);
      else if (type === RESULT) pending?.resolve({ json, payload, session: session.id });
      else if (type === ERROR) pending?.reject(new RemoteError(json));
    }
  }
}

const indexOf = (haystack: Uint8Array, needle: Uint8Array) => {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
};
