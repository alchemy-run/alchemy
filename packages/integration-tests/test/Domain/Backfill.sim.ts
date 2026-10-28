import * as Backfill from "@alchemy.run/domain/Backfill";
import type { Routed } from "@alchemy.run/domain/CatchUp";
import type { Delivery } from "@alchemy.run/domain/Platform";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/**
 * A deterministic simulation of the backfill protocol: every role runs its
 * real code over in-process storage, jobs and network, driven by a seeded
 * scheduler that injects failures, crashes and stale code.
 */

/** A seeded PRNG (mulberry32): the same seed explores the same interleaving. */
const rng = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

class Crash extends Error {
  override readonly name = "Crash";
}

export interface Faults {
  /** Chance a call fails before it reaches its object. */
  readonly callBefore: number;
  /** Chance a call runs but its answer is lost. */
  readonly callAfter: number;
  /** Chance an exclusive section crashes before it commits (its writes roll back). */
  readonly crash: number;
}

export const noFaults: Faults = { callBefore: 0, callAfter: 0, crash: 0 };

/** One durable object: sorted storage, an exclusive lock, and its scheduled jobs. */
class SimObject {
  readonly data = new Map<string, unknown>();
  overlay: Map<string, unknown> | undefined;
  readonly jobs = new Map<string, number>();
  constructor(
    readonly address: string,
    readonly sim: Sim,
  ) {}

  private read(key: string) {
    if (this.overlay?.has(key)) return this.overlay.get(key);
    return this.data.get(key);
  }

  readonly storage: Backfill.Storage = {
    get: <A>(key: string) => Effect.sync(() => this.read(key) as A | undefined),
    put: (entries) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(entries)) {
          (this.overlay ?? this.data).set(key, value);
        }
      }),
    delete: (keys) =>
      Effect.sync(() => {
        for (const key of keys) (this.overlay ?? this.data).set(key, undefined);
        if (!this.overlay) for (const key of keys) this.data.delete(key);
      }),
    list: <A>(options: { prefix: string; startAfter?: string; limit?: number }) =>
      Effect.sync(() => {
        const keys = new Set([...this.data.keys(), ...(this.overlay?.keys() ?? [])]);
        const out: Array<readonly [string, A]> = [];
        for (const key of [...keys].sort()) {
          if (!key.startsWith(options.prefix)) continue;
          if (options.startAfter !== undefined && key <= options.startAfter) continue;
          const value = this.read(key);
          if (value === undefined) continue;
          out.push([key, value as A]);
          if (options.limit !== undefined && out.length >= options.limit) break;
        }
        return out;
      }),
    exclusive: <A, E>(effect: Effect.Effect<A, E>) => this.section(effect, true),
  };

  private readonly lock = Semaphore.makeUnsafe(1);

  /**
   * One exclusive section: its writes commit together, or, when it crashes
   * before committing, not at all. Client commits pass `crashes: false`.
   */
  section<A, E>(effect: Effect.Effect<A, E>, crashes: boolean): Effect.Effect<A, E> {
    return this.lock.withPermits(1)(
      Effect.suspend(() => {
        this.overlay = new Map();
        return effect.pipe(
          Effect.tap(() =>
            crashes && this.sim.chance(this.sim.faults.crash)
              ? Effect.die(new Crash(`${this.address} crashed before committing`))
              : Effect.void,
          ),
          Effect.tap(() =>
            Effect.sync(() => {
              for (const [key, value] of this.overlay!) {
                if (value === undefined) this.data.delete(key);
                else this.data.set(key, value);
              }
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              this.overlay = undefined;
            }),
          ),
        );
      }),
    );
  }

  readonly jobsApi: Backfill.Jobs = {
    schedule: (id, afterMillis) =>
      Effect.sync(() => {
        this.jobs.set(id, this.sim.now + afterMillis);
      }),
  };
}

/** A simulated source instance: an event log with routing, like an aggregate. */
interface SourceData {
  readonly ref: Backfill.SourceRef;
  readonly object: SimObject;
  readonly events: Array<{
    readonly seq: number;
    readonly at: number;
    readonly keys: ReadonlyArray<string>;
  }>;
  /** Runs code that knows the target only from this time on. */
  staleUntil: number;
  role: Backfill.Source;
}

/** A simulated consumer key: applies deliveries, deduping by source seq, like a view key. */
interface KeyData {
  readonly key: string;
  readonly object: SimObject;
  readonly applied: Array<{ readonly delivery: Delivery; readonly backfilling: boolean }>;
  readonly checkpoints: Map<string, number>;
  /** Runs code from before the target's generation until this time. */
  staleUntil: number;
  role: Backfill.Consumer;
}

export class Sim {
  readonly random: () => number;
  now = 1_000_000;
  readonly nodes = new Map<string, { object: SimObject; role: Backfill.Node }>();
  readonly sources = new Map<string, SourceData>();
  readonly keys = new Map<string, KeyData>();
  /** Live deliveries waiting to be sent, in order per source (its outbox): retried until they land. */
  readonly outbox = new Map<string, Array<Delivery>>();
  /** Every consumer deployed together. */
  get targets(): ReadonlyArray<string> {
    return [this.target, ...this.others];
  }

  /** A key of `target`: the primary target's keys are plain, the others' are prefixed. */
  keyOf(target: string, key: string) {
    return target === this.target ? key : `${target}|${key}`;
  }

  /** The target a key belongs to. */
  targetOfKey(key: string) {
    const bar = key.indexOf("|");
    return bar < 0 ? this.target : key.slice(0, bar);
  }

  /** The target exists (the consumer is deployed). */
  deployed = false;
  calls = 0;
  failures = 0;

  constructor(
    seed: number,
    readonly target: string,
    readonly faults: Faults = noFaults,
    readonly limits: Backfill.Limits = {
      ...Backfill.defaultLimits,
      page: 3,
      nodePage: 2,
      apply: 4,
    },
    /** More consumers deployed at the same time: they share the directory and the sources. */
    readonly others: ReadonlyArray<string> = [],
  ) {
    this.random = rng(seed);
  }

  chance(p: number) {
    return p > 0 && this.random() < p;
  }

  /**
   * A Durable Object keeps the code it started with while calls keep it busy:
   * a call to one still on older code holds it there for another 20 seconds.
   */
  busy<O extends { staleUntil: number }>(object: O): O {
    if (this.now < object.staleUntil)
      object.staleUntil = Math.max(object.staleUntil, this.now + 20_000);
    return object;
  }

  /** Every call crosses the network: it may fail before it runs, or after. */
  private call<A>(effect: () => Effect.Effect<A>): Effect.Effect<A> {
    return Effect.suspend(() => {
      this.calls += 1;
      if (this.chance(this.faults.callBefore)) {
        this.failures += 1;
        return Effect.die(new Crash("call failed in transit"));
      }
      return effect().pipe(
        Effect.tap(() => {
          if (!this.chance(this.faults.callAfter)) return Effect.void;
          this.failures += 1;
          return Effect.die(new Crash("answer lost in transit"));
        }),
      );
    });
  }

  readonly net: Backfill.Network = {
    node: {
      register: (path, ref) => this.call(() => this.node(path).role.register(path, ref)),
      child: (path, child) => this.call(() => this.node(path).role.child(path, child)),
      news: (path, targets) => this.call(() => this.node(path).role.news(path, targets)),
      sweep: (path, target, phase) =>
        this.call(() => this.node(path).role.sweep(path, target, phase)),
      report: (path, target, phase, child) =>
        this.call(() => this.node(path).role.report(path, target, phase, child)),
      settled: (path, target, ref) =>
        this.call(() => this.node(path).role.settled(path, target, ref)),
      phase: (path, target) => this.call(() => this.node(path).role.phase(path, target)),
      status: (path) => this.call(() => this.node(path).role.status(path)),
    },
    source: {
      scan: (ref, target) => this.call(() => this.busy(this.source(ref)).role.scan(target)),
      ready: (ref, target) => this.call(() => this.busy(this.source(ref)).role.ready(target)),
      pull: (ref, target, key, after) =>
        this.call(() => this.busy(this.source(ref)).role.pull(target, key, after)),
    },
    consumer: {
      source: (target, key, stream, ref) =>
        this.call(() => this.busy(this.key(key)).role.source(target, stream, ref)),
      ready: (target, key) => this.call(() => this.busy(this.key(key)).role.ready(target)),
    },
  };

  node(path: string) {
    let node = this.nodes.get(path);
    if (!node) {
      const object = new SimObject(`node:${path}`, this);
      node = {
        object,
        role: Backfill.makeNode(object.storage, object.jobsApi, this.net, this.limits),
      };
      this.nodes.set(path, node);
    }
    return node;
  }

  private streamOf(ref: Backfill.SourceRef) {
    return `${ref.source}/${ref.id}`;
  }

  /** An event's deliveries to one target (or every target). */
  private deliveries(
    source: SourceData,
    event: SourceData["events"][number],
    history = false,
    only?: string,
  ): Array<Delivery> {
    const stream = this.streamOf(source.ref);
    return this.targets
      .filter((target) => only === undefined || target === only)
      .flatMap((target) => {
        const [, rest] = target.split(":") as [string, string];
        const [name, generation] = rest.split("#") as [string, string | undefined];
        return event.keys.map((key) => ({
          target: {
            kind: "view" as const,
            name,
            ...(generation ? { generation: Number(generation) } : {}),
          },
          key: this.keyOf(target, key),
          source: stream,
          seq: event.seq,
          origin: source.ref.source,
          tag: "E",
          event: { _tag: "E", seq: event.seq },
          envelope: { id: source.ref.id, stream, seq: event.seq, at: event.at, commandId: "" },
          ...(history ? { history } : {}),
        }));
      });
  }

  source(ref: Backfill.SourceRef): SourceData {
    const id = this.streamOf(ref);
    let source = this.sources.get(id);
    if (!source) {
      const object = new SimObject(`source:${id}`, this);
      const data: SourceData = {
        ref,
        object,
        events: [],
        staleUntil: 0,
        role: undefined as never,
      };
      const knows = () => this.deployed && this.now >= data.staleUntil;
      data.role = Backfill.makeSource(
        object.storage,
        object.jobsApi,
        this.net,
        {
          ref,
          targets: () => (knows() ? this.targets : []),
          model: () => (knows() ? this.targets : []),
          version: Effect.sync(() => data.events.length),
          // Kept in the object's storage, so a crashed step rolls it back with the rest.
          routed: object.storage.get<Routed>("routed"),
          markLive: (target) =>
            Effect.flatMap(object.storage.get<Routed>("routed"), (routed) =>
              object.storage.put({ routed: { ...routed, [target]: data.events.length } }),
            ),
          rows: (after, limit, target) =>
            Effect.sync(() =>
              data.events
                .filter((event) => event.seq > after)
                .slice(0, limit)
                .map((event) => ({
                  seq: event.seq,
                  deliveries: this.deliveries(data, event, true, target),
                })),
            ),
          rowsAt: (seqs, target) =>
            Effect.sync(() =>
              seqs.flatMap((seq) => this.deliveries(data, data.events[seq - 1]!, true, target)),
            ),
        },
        this.limits,
      );
      source = data;
      this.sources.set(id, source);
    }
    return source;
  }

  key(key: string): KeyData {
    let data = this.keys.get(key);
    if (!data) {
      const object = new SimObject(`key:${key}`, this);
      const keyData: KeyData = {
        key,
        object,
        applied: [],
        checkpoints: new Map(),
        staleUntil: this.keyStaleUntil(key),
        role: undefined as never,
      };
      keyData.role = Backfill.makeConsumer(
        object.storage,
        object.jobsApi,
        this.net,
        {
          key,
          // Older code runs the previous generation of the consumer.
          target: () => {
            const target = this.targetOfKey(key);
            return this.now >= keyData.staleUntil ? target : target.replace(/#\d+$/, "");
          },
          apply: (deliveries) => Effect.sync(() => this.apply(keyData, deliveries, true)),
        },
        this.limits,
      );
      data = keyData;
      this.keys.set(key, data);
    }
    return data;
  }

  private apply(key: KeyData, deliveries: ReadonlyArray<Delivery>, backfilling: boolean) {
    for (const delivery of deliveries) {
      if ((key.checkpoints.get(delivery.source) ?? 0) >= delivery.seq) continue;
      key.checkpoints.set(delivery.source, delivery.seq);
      key.applied.push({ delivery, backfilling });
    }
  }

  /**
   * Commit an event on a source, as an aggregate does: decide routing under its
   * lock, then send what goes out live. The first commit lists it in the directory.
   */
  commit(sourceId: string, keys: ReadonlyArray<string>, staleUntil = 0) {
    const [name, id] = sourceId.split("/") as [string, string];
    const source = this.source({ source: name, id });
    if (source.events.length === 0) source.staleUntil = staleUntil;
    this.busy(source);
    const knows = this.deployed && this.now >= source.staleUntil;
    // The first commit lists the instance in the directory before it persists.
    const register =
      source.events.length === 0
        ? this.retry(this.net.node.register(Backfill.leafOf(source.ref), source.ref))
        : Effect.void;
    return register.pipe(
      Effect.andThen(
        source.object
          .section(
            Effect.gen({ self: this }, function* () {
              const before = source.events.length;
              const event = { seq: before + 1, at: this.now, keys };
              source.events.push(event);
              const storage = source.object.storage;
              const routed = yield* storage.get<Routed>("routed");
              if (!knows) {
                // Code without the targets: it routes nothing to them, and its cursors stay.
                yield* storage.put({ routed: { ...routed } });
                return [] as ReadonlyArray<Delivery>;
              }
              let next: Record<string, number> = {
                ...(routed ?? Object.fromEntries(this.targets.map((t) => [t, before]))),
              };
              const send: Array<Delivery> = [];
              for (const target of this.targets) {
                const deliveries = this.deliveries(source, event, false, target);
                if ((next[target] ?? 0) === before) {
                  next = { ...next, [target]: before + 1 };
                  send.push(...deliveries);
                } else {
                  send.push(
                    ...(yield* source.role.onCommit(target, deliveries, before, before + 1)),
                  );
                }
              }
              yield* storage.put({ routed: next });
              return send as ReadonlyArray<Delivery>;
            }),
            // A client's command: it is retried by the client, never lost halfway.
            false,
          )
          .pipe(
            Effect.tap((send) =>
              Effect.sync(() => {
                for (const delivery of send) {
                  const queue = this.outbox.get(delivery.source) ?? [];
                  queue.push(delivery);
                  this.outbox.set(delivery.source, queue);
                }
              }),
            ),
          ),
      ),
    );
  }

  /** Retry a call until it lands (a durable outbox would). */
  retry<A>(effect: Effect.Effect<A>): Effect.Effect<A> {
    return Effect.suspend(function loop(): Effect.Effect<A> {
      return effect.pipe(Effect.catchCause(() => Effect.suspend(loop)));
    });
  }

  /** Keys that run older code for a while: by key, until when. */
  readonly staleKeys = new Map<string, number>();
  private keyStaleUntil(key: string) {
    return this.staleKeys.get(key) ?? 0;
  }

  /** Deliver one queued live delivery. */
  private sendOne(delivery: Delivery) {
    const key = this.key(delivery.key);
    // Older code refuses a newer generation's delivery (its apply dies); the sender retries.
    if (this.now < this.busy(key).staleUntil)
      return Effect.die(new Crash("key still on older code"));
    return key.role
      .admit(this.targetOfKey(delivery.key), [delivery])
      .pipe(
        Effect.flatMap((apply) =>
          apply
            ? key.object.storage.exclusive(Effect.sync(() => this.apply(key, [delivery], false)))
            : Effect.void,
        ),
      );
  }

  /** Every job and queued delivery due now, or the time the next one is. */
  private due() {
    const due: Array<() => Effect.Effect<void>> = [];
    let next = Number.POSITIVE_INFINITY;
    const collect = (object: SimObject, run: (id: string) => Effect.Effect<void>) => {
      for (const [id, at] of object.jobs) {
        if (at <= this.now)
          due.push(() =>
            Effect.suspend(() => {
              object.jobs.delete(id);
              return run(id).pipe(
                // A failed job is retried, like a durable callback.
                Effect.catchCause(() =>
                  Effect.sync(() => {
                    if (!object.jobs.has(id)) object.jobs.set(id, this.now + 1_000);
                  }),
                ),
              );
            }),
          );
        else next = Math.min(next, at);
      }
    };
    for (const { object, role } of this.nodes.values()) collect(object, role.run);
    for (const source of this.sources.values()) collect(source.object, () => source.role.flush);
    for (const key of this.keys.values())
      collect(key.object, (id) => key.role.merge(id.slice("bf-merge:".length)));
    for (const queue of this.outbox.values()) {
      if (queue.length === 0) continue;
      // The head of one source's outbox: a failed send stays at the head.
      due.push(() =>
        this.sendOne(queue[0]!).pipe(
          Effect.tap(() => Effect.sync(() => queue.shift())),
          Effect.catchCause(() => Effect.void),
        ),
      );
    }
    return { due, next };
  }

  /** Run one due job (picked at random), or move the clock to the next. `false` when idle. */
  step(): Effect.Effect<boolean> {
    return Effect.suspend(() => {
      const { due, next } = this.due();
      if (due.length > 0) {
        const pick = due[Math.floor(this.random() * due.length)]!;
        return pick().pipe(Effect.as(true));
      }
      if (next === Number.POSITIVE_INFINITY) return Effect.succeed(false);
      this.now = next;
      return Effect.succeed(true);
    });
  }

  /**
   * Deploy the consumer: code that knows it, and the news of it. Instances
   * running at the time keep their older code until they have been idle.
   */
  deploy(options: { readonly running?: boolean } = {}) {
    this.deployed = true;
    if (options.running)
      for (const source of this.sources.values())
        source.staleUntil = Math.max(source.staleUntil, this.now + 20_000);
    return this.retry(this.net.node.news("a7", this.targets));
  }

  /** Run until nothing is left to do, interleaving `actions` (client commits). */
  run(
    actions: Array<() => Effect.Effect<unknown>> = [],
    options: { readonly maxSteps?: number } = {},
  ) {
    return Effect.gen({ self: this }, function* () {
      const pending = [...actions];
      for (let steps = 0; steps < (options.maxSteps ?? 200_000); steps++) {
        if (pending.length > 0 && this.random() < 0.2) {
          this.now += 1;
          yield* pending.shift()!();
          continue;
        }
        const busy = yield* this.step();
        if (!busy && pending.length === 0) return steps;
        if (!busy) {
          this.now += 1;
          yield* pending.shift()!();
        }
      }
      return yield* Effect.die(new Error("the simulation did not settle"));
    });
  }

  /** The root's status for the target. */
  status() {
    return this.node("").role.status("");
  }
}
