import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { Cursor, SessionEvent, SessionEventInput } from "./Session.ts";

/**
 * The append-only event log behind every session: harness servers append
 * normalized events, readers replay from a cursor and then follow live.
 *
 * A container's disk does not survive sleep, so on Cloudflare the log lives
 * in the owning Durable Object (`Cloudflare.DurableSessionStore`);
 * {@link MemorySessionStore} serves local runs and tests.
 */
export interface SessionStoreService {
  /** Append an event, stamping its `cursor`, `sessionId`, and `at`. */
  readonly append: (sessionId: string, event: SessionEventInput) => Effect.Effect<SessionEvent>;
  /**
   * Events with `cursor > after`: everything stored, then live appends, with
   * no gap or duplicate between the two. Completes after a `state: closed`
   * event.
   */
  readonly read: (
    sessionId: string,
    options?: { readonly after?: Cursor },
  ) => Stream.Stream<SessionEvent>;
  /** The latest cursor (0 for an empty log). */
  readonly latest: (sessionId: string) => Effect.Effect<Cursor>;
}

export class SessionStore extends Context.Service<SessionStore, SessionStoreService>()(
  "AI.SessionStore",
) {}

const isClosed = (event: SessionEvent) => event.type === "state" && event.state === "closed";

/**
 * Build a store over any snapshot persistence: `load` returns the stored
 * events after a cursor, `save` persists one stamped event. Live tailing is
 * an in-process `PubSub` per session — correct wherever all appends for a
 * session happen in one process (a Durable Object, a container, a test).
 */
export const makeSessionStore = (persistence: {
  readonly load: (sessionId: string, after: Cursor) => Effect.Effect<ReadonlyArray<SessionEvent>>;
  readonly save: (event: SessionEvent) => Effect.Effect<void>;
  readonly latest: (sessionId: string) => Effect.Effect<Cursor>;
}): Effect.Effect<SessionStoreService> =>
  Effect.gen(function* () {
    const topics = new Map<string, PubSub.PubSub<SessionEvent>>();
    const topic = (sessionId: string) =>
      Effect.suspend(() => {
        const existing = topics.get(sessionId);
        if (existing) return Effect.succeed(existing);
        return Effect.map(PubSub.unbounded<SessionEvent>(), (created) => {
          topics.set(sessionId, created);
          return created;
        });
      });
    // Appends for one session are serialized so cursors never interleave.
    const locks = new Map<string, Semaphore.Semaphore>();
    const lock = (sessionId: string) => {
      let s = locks.get(sessionId);
      if (!s) {
        s = Semaphore.makeUnsafe(1);
        locks.set(sessionId, s);
      }
      return s;
    };

    const append = (sessionId: string, input: SessionEventInput) =>
      lock(sessionId).withPermits(1)(
        Effect.gen(function* () {
          const cursor = (yield* persistence.latest(sessionId)) + 1;
          const event = { ...input, sessionId, cursor, at: Date.now() } as SessionEvent;
          yield* persistence.save(event);
          yield* PubSub.publish(yield* topic(sessionId), event);
          return event;
        }),
      );

    const read = (sessionId: string, options?: { readonly after?: Cursor }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const after = options?.after ?? 0;
          // Subscribe BEFORE snapshotting: anything appended in between is in
          // the subscription, and the cursor filter drops what the snapshot
          // already covered.
          const subscription = yield* PubSub.subscribe(yield* topic(sessionId));
          const snapshot = yield* persistence.load(sessionId, after);
          const last = snapshot.length > 0 ? snapshot[snapshot.length - 1]!.cursor : after;
          const replay = Stream.fromIterable(snapshot);
          if (snapshot.some(isClosed)) return replay.pipe(Stream.takeUntil(isClosed));
          const live = Stream.fromSubscription(subscription).pipe(
            Stream.filter((event) => event.cursor > last),
          );
          return Stream.concat(replay, live).pipe(Stream.takeUntil(isClosed));
        }),
      ).pipe(Stream.scoped);

    return { append, read, latest: persistence.latest } satisfies SessionStoreService;
  });

/** An in-memory {@link SessionStore} — local runs and tests. */
export const MemorySessionStore: Layer.Layer<SessionStore> = Layer.effect(SessionStore)(
  Effect.suspend(() => {
    const logs = new Map<string, SessionEvent[]>();
    const log = (sessionId: string) => {
      let l = logs.get(sessionId);
      if (!l) {
        l = [];
        logs.set(sessionId, l);
      }
      return l;
    };
    return makeSessionStore({
      load: (sessionId, after) => Effect.sync(() => log(sessionId).filter((e) => e.cursor > after)),
      save: (event) => Effect.sync(() => void log(event.sessionId).push(event)),
      latest: (sessionId) =>
        Effect.sync(() => {
          const l = log(sessionId);
          return l.length > 0 ? l[l.length - 1]!.cursor : 0;
        }),
    });
  }),
);
