import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type { KernelEvent } from "./Kernel.ts";

/**
 * The durability seam (design §2.7): the pluggable *backend* behind the
 * normative persistence protocol. The Kernel interface never mentions
 * this tag — it is a service of particular Kernel implementations
 * (resolved via `Effect.serviceOption` with an internal default, the
 * §2.6 seam pattern), overridable by providing a different Layer to the
 * kernel Layer.
 *
 * The protocol the backend must implement (normative, §2.7):
 *
 * - **`commit` is the stash point** — one transactional append. Durable
 *   events receive their per-ring `seq` *inside* the commit; the batch
 *   boundary is semantic (the caller's write-ahead ordering), never a
 *   timer or a count.
 * - **Rows are truth, wakes are hints** — `trace` replays committed rows
 *   from a cursor and only then tails live commits; a subscriber can
 *   never observe a gap between replay and tail.
 * - **Live deltas are never stored** — events with `durable: false` are
 *   published to the firehose and dropped; they carry no `seq` and can
 *   never advance a cursor, by construction.
 *
 * The ladder of Layers (§3.2): {@link TraceStoreMemory} (dev/test, this
 * file) → `doFiber` (Durable Object storage, Phase 3) → `workflow` →
 * `think` interop.
 */
export interface TraceStoreService {
  /**
   * The stash point: atomically assign `seq` to the durable events,
   * append them to their ring's Trace, and publish everything (durable
   * and live alike) to the firehose. Returns the events as committed
   * (durable ones now carrying `seq`).
   */
  commit(
    events: ReadonlyArray<KernelEvent>,
  ): Effect.Effect<ReadonlyArray<KernelEvent>>;
  /**
   * Durable replay-then-tail over one ring's Trace: every committed row
   * with `seq > after`, in order, then live commits as they land.
   */
  trace(ring: string, after?: number): Stream.Stream<KernelEvent>;
  /** Live firehose: all rings, deltas included, no replay guarantee. */
  events: Stream.Stream<KernelEvent>;
}

export class TraceStore extends Context.Service<
  TraceStore,
  TraceStoreService
>()("alchemy/AI/TraceStore") {}

/** One ring's key in the store: the ring path, outermost first. */
const ringKey = (ring: ReadonlyArray<string>): string => ring.join("/");

/**
 * The in-memory reference implementation: an array per ring + a seq
 * counter + a synchronous "transaction" (JS single-threadedness makes
 * `commit` atomic for free — the DO implementation swaps in
 * `storage.transaction`, §2.7).
 */
export const makeMemoryTraceStore: Effect.Effect<TraceStoreService> =
  Effect.gen(function* () {
    const rows = new Map<string, KernelEvent[]>();
    const seqs = new Map<string, number>();
    const firehose = yield* PubSub.unbounded<KernelEvent>();

    const commit = (events: ReadonlyArray<KernelEvent>) =>
      Effect.gen(function* () {
        // the "transaction": seq assignment + append happen synchronously,
        // before any publish is observable
        const committed = events.map((event) => {
          if (!event.durable) return event;
          const key = ringKey(event.ring);
          const seq = (seqs.get(key) ?? 0) + 1;
          seqs.set(key, seq);
          const row = { ...event, seq };
          const ring = rows.get(key);
          if (ring === undefined) rows.set(key, [row]);
          else ring.push(row);
          return row;
        });
        yield* Effect.forEach(committed, (event) =>
          PubSub.publish(firehose, event),
        );
        return committed;
      });

    const trace = (ring: string, after = 0): Stream.Stream<KernelEvent> =>
      Stream.unwrap(
        Effect.gen(function* () {
          // subscribe FIRST, snapshot second: anything committed between
          // the two shows up in both and is de-duplicated by seq — the
          // no-gap guarantee.
          const live = yield* PubSub.subscribe(firehose);
          const replay = [...(rows.get(ring) ?? [])].filter(
            (event) => (event.seq ?? 0) > after,
          );
          const horizon =
            replay.length > 0 ? replay[replay.length - 1]!.seq! : after;
          return Stream.concat(
            Stream.fromIterable(replay),
            Stream.fromSubscription(live).pipe(
              Stream.filter(
                (event) =>
                  event.durable &&
                  ringKey(event.ring) === ring &&
                  (event.seq ?? 0) > horizon,
              ),
            ),
          );
        }),
      );

    return {
      commit,
      trace,
      events: Stream.fromPubSub(firehose),
    };
  });

export const TraceStoreMemory: Layer.Layer<TraceStore> = Layer.effect(
  TraceStore,
  Effect.map(makeMemoryTraceStore, (store) => TraceStore.of(store)),
);
