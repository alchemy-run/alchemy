import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";

/**
 * Fan-out: work through a very large set of items, each handled by a call to
 * some object, from one root object, without a central coordinator holding
 * them all at once.
 *
 * - **The root** of a run drives passes from its own durable jobs. Each pass
 *   works through the run's frontier (items, and paths that list more) in
 *   windows: like TCP's congestion window, the window grows while the account
 *   takes the load and halves when Cloudflare refuses calls, so a wide run
 *   stays under the account's limit instead of hitting it and waiting it out.
 *   It marks each frontier entry done as it goes, so a pass that runs again
 *   skips what is done.
 * - **Relays** form a tree under it, each its own object: given more than
 *   {@link RELAY_FANOUT} entries a relay splits them among child relays (an
 *   object runs at most six outgoing calls at once); given a path it lists it
 *   and works through what it lists; given items it handles each one. Every
 *   relay answers once everything under it is done, so a pass is done when the
 *   first one answers, after about log6 of the items levels of calls.
 *
 * Relays keep no state: one that fails is called again, and work already done
 * answers at once. An item's handler must be idempotent, and may answer
 * `false` (not done yet): the relay calls it again until the pass's deadline.
 *
 * The backfill of a view or projection is one fan-out (its frontier is the
 * directory of source instances); moving a Domain's Durable Objects to a new
 * layout is another (its frontier is the objects to move).
 *
 * @internal
 */

// ---------------------------------------------------------------- shared

/**
 * Cloudflare refuses calls when an account puts too much load on Durable
 * Objects, and resets an isolate whose objects (many share one) use too much
 * memory. Either is a sign to send less: a refused call is tried again later,
 * not at once, so a wide run backs off to the load the account can take
 * rather than collapse under its own retries.
 */
export const overloaded = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return /too much load|too many concurrent|overloaded|try again later|exceeded its memory limit/i.test(
    Predicate.hasProperty(error, "message") ? String(error.message) : String(error),
  );
};

/** A wait after `failures` failures in a row: doubling from `base`, up to `max`, jittered. */
export const backoff = (failures: number, base: number, max: number) =>
  Effect.map(Random.next, (jitter) =>
    Math.round(Math.min(max, base * 2 ** Math.max(0, failures - 1)) * (0.5 + jitter)),
  );

/** A key-ordered store, as a Durable Object's storage is. */
export interface Storage {
  readonly get: <A>(key: string) => Effect.Effect<A | undefined>;
  readonly put: (entries: Readonly<Record<string, unknown>>) => Effect.Effect<void>;
  readonly delete: (keys: ReadonlyArray<string>) => Effect.Effect<void>;
  /** Entries under `prefix`, in key order, after `startAfter`. */
  readonly list: <A>(options: {
    readonly prefix: string;
    readonly startAfter?: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<readonly [string, A]>>;
  /** Run `effect` with every other call on this object held back. */
  readonly exclusive: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>;
}

/** Durable, at-least-once jobs on one object: a job with the same id replaces a pending one. */
export interface Jobs {
  /**
   * Run job `id` after `afterMillis`. The earliest request wins: a job already due
   * sooner isn't postponed (every job is idempotent, so running early is safe),
   * including one asked for while that job runs.
   */
  readonly schedule: (id: string, afterMillis: number) => Effect.Effect<void>;
}

// ---------------------------------------------------------------- relays

/** What a relay works through: paths to list, and items to handle. */
export type Entry<Item> = { readonly path: string } | { readonly ref: Item };

/** A pass of a relay tree: whatever the work needs to know, and when the pass answers. */
export interface Pass {
  /**
   * When the pass answers (epoch ms): each relay keeps at its entries until then,
   * and answers `false` for those not done. Now, for one try at everything.
   */
  readonly deadline: number;
}

/** What a relay answers: which of its entries are done, and how many calls the account's load refused. */
export interface Result {
  readonly done: ReadonlyArray<boolean>;
  readonly refused: number;
  /** Items done under it. */
  readonly instances?: number;
  /** A call it gave up on, and why. */
  readonly failure?: string;
}

/** A page of what a path lists. */
export interface Listed<Item> {
  readonly entries: ReadonlyArray<Entry<Item>>;
  /** Where the next page starts, if there is one. */
  readonly next?: string;
}

/** What a fan-out does: how it lists a path, handles an item, and reaches its relays. */
export interface Work<P extends Pass, Item> {
  /** Names the work in logs (`backfill`, `move`). */
  readonly label: string;
  /** A page of what `path` lists. */
  readonly list: (pass: P, path: string, after: string | undefined) => Effect.Effect<Listed<Item>>;
  /**
   * Handle one item: `true` once it is done. It may take up to `waitMillis`
   * to say so; `false` is asked again until the pass's deadline.
   */
  readonly handle: (pass: P, item: Item, waitMillis: number) => Effect.Effect<boolean>;
  /** Names an item, in logs and in the root's marks of what is done. */
  readonly describe: (item: Item) => string;
  /** Call the relay named `name` (each its own object) with a share of the entries. */
  readonly relay: (
    name: string,
    pass: P,
    entries: ReadonlyArray<Entry<Item>>,
  ) => Effect.Effect<Result>;
}

/**
 * How many calls a relay makes at once: Cloudflare runs at most six outgoing
 * calls per invocation, so a wider relay would queue its own calls.
 */
export const RELAY_FANOUT = 6;

/** How long an item works before it answers a relay that is waiting for it. */
const RELAY_ITEM_WAIT_MS = 10_000;

/**
 * How many entries a run's root lists its frontier into, at least: small
 * steps for its window, a few hundred items each at a million.
 */
const FRONTIER_SIZE = 512;

/** A relay's count of what happened under it. */
interface Tally {
  refused: number;
  instances: number;
  failure?: string;
}

/** How long a call may take, beyond the work it was asked to wait for, before it counts as lost. */
const CALL_TIMEOUT_MS = 20_000;

/**
 * How long a relay waits before it calls again after a failure, doubling each
 * time up to {@link RELAY_RETRY_MAX_MS}: an object still on older code moves to
 * the deployed code only once it has been idle, so calls at a fixed short pace
 * would keep it there.
 */
const RELAY_RETRY_MS = 250;
export const RELAY_RETRY_MAX_MS = 30_000;
/** Calls the account's load refused before a relay gives an entry back to the run's root. */
const RELAY_REFUSALS = 3;
/** Failed calls a relay makes again at once, before it waits. */
const RELAY_RETRY_AT_ONCE = 2;

/**
 * A relay: one node of the tree a pass fans out over. It keeps no state: a
 * relay that fails is called again, and work already done answers at once.
 */
export const makeRelay = <P extends Pass, Item>(work: Work<P, Item>) => {
  /**
   * Keep at `effect` until it succeeds or `until` (epoch ms) has passed; `undefined`
   * then, after logging why (`what` names the call).
   */
  const persist = <A>(
    effect: Effect.Effect<A>,
    until: number,
    what: () => string,
    /** How long one attempt may take before it counts as lost: a hung call would stall its subtree. */
    attempt: () => Effect.Effect<number> = () => Effect.succeed(CALL_TIMEOUT_MS),
    /** Counts the calls the account's load refused, for the run's root to pace itself by. */
    tally?: Tally,
  ): Effect.Effect<A | undefined> =>
    Effect.gen(function* () {
      // A pass with no time to retry (one try at everything) expects failures: it doesn't log them.
      const quiet = until <= (yield* Clock.currentTimeMillis);
      for (let tries = 0, refusals = 0; ; tries++) {
        const limit = yield* attempt();
        const result = yield* (
          quiet ? effect : effect.pipe(Effect.timeout(`${limit} millis`))
        ).pipe(
          Effect.map((value) => ({ value })),
          Effect.catchCause((cause) => Effect.succeed({ cause })),
        );
        if ("value" in result) return result.value;
        // A call lost in transit: try again at once, a couple of times, then wait. A
        // call the account's load refused: wait at once, longer each time.
        const refused = overloaded(result.cause);
        const failure = () => `${what()}: ${String(Cause.squash(result.cause)).slice(0, 300)}`;
        if (refused && tally !== undefined) tally.refused += 1;
        // Refused a few times: give it back to the run's root, which sends it again at a
        // lower load, rather than hold the rest of its round until the pass's deadline.
        if (refused && ++refusals >= RELAY_REFUSALS) {
          if (tally !== undefined) tally.failure ??= failure();
          return undefined;
        }
        if (!refused && tries < RELAY_RETRY_AT_ONCE) continue;
        const wait = yield* backoff(
          refused ? tries + 1 : tries - RELAY_RETRY_AT_ONCE + 1,
          refused ? 1_000 : RELAY_RETRY_MS,
          RELAY_RETRY_MAX_MS,
        );
        if ((yield* Clock.currentTimeMillis) + wait >= until) {
          if (!quiet) yield* Effect.logInfo(`${work.label} relay-failed ${failure()}`);
          if (tally !== undefined) tally.failure ??= failure();
          return undefined;
        }
        yield* Effect.sleep(`${wait} millis`);
      }
    });

  /** Every page `path` lists. */
  const listed = (pass: P, path: string, until: number, tally?: Tally) =>
    Effect.gen(function* () {
      const entries: Array<Entry<Item>> = [];
      let after: string | undefined;
      while (true) {
        const page = yield* persist(
          work.list(pass, path, after),
          until,
          () => `list ${path}`,
          undefined,
          tally,
        );
        if (page === undefined) return undefined;
        entries.push(...page.entries);
        if (page.next === undefined) return entries;
        after = page.next;
      }
    });

  /** One item's part of a pass; keep at it until it is done, or time is up. */
  const item = (pass: P, ref: Item, until: number, tally: Tally) =>
    Effect.gen(function* () {
      const quiet = until <= (yield* Clock.currentTimeMillis);
      while (true) {
        const left = until - (yield* Clock.currentTimeMillis);
        const wait = Math.max(0, Math.min(RELAY_ITEM_WAIT_MS, left));
        const done = yield* persist(
          work.handle(pass, ref, wait),
          until,
          () => work.describe(ref),
          () => Effect.succeed(wait + CALL_TIMEOUT_MS),
          tally,
        );
        if (done === true) {
          tally.instances += 1;
          return true;
        }
        if ((yield* Clock.currentTimeMillis) >= until) {
          if (done === false && !quiet)
            yield* Effect.logInfo(`${work.label} relay-pending ${work.describe(ref)}`);
          return false;
        }
      }
    });

  const run = (name: string, pass: P, entries: ReadonlyArray<Entry<Item>>): Effect.Effect<Result> =>
    Effect.gen(function* () {
      const tally: Tally = { refused: 0, instances: 0 };
      const done = yield* through(name, pass, entries, tally);
      return {
        done,
        refused: tally.refused,
        instances: tally.instances,
        ...(tally.failure === undefined ? {} : { failure: tally.failure }),
      };
    });

  /** Work through `entries`: whether each is done. */
  const through = (
    name: string,
    pass: P,
    entries: ReadonlyArray<Entry<Item>>,
    tally: Tally,
  ): Effect.Effect<ReadonlyArray<boolean>> =>
    Effect.gen(function* () {
      const until = pass.deadline;
      const child = (suffix: string, chunk: ReadonlyArray<Entry<Item>>) =>
        Effect.map(
          persist(
            work.relay(`${name}${suffix}`, pass, chunk),
            until,
            () => `relay ${name}${suffix}`,
            // A child answers by the pass's deadline: allow it that, and a little more.
            () => Effect.map(Clock.currentTimeMillis, (now) => until - now + CALL_TIMEOUT_MS),
            tally,
          ),
          (result): ReadonlyArray<boolean> => {
            if (result === undefined) return chunk.map(() => false);
            tally.refused += result.refused;
            tally.instances += result.instances ?? 0;
            tally.failure ??= result.failure;
            return result.done;
          },
        );
      if (entries.length > RELAY_FANOUT) {
        // Too many to call at once: split them among child relays.
        const size = Math.ceil(entries.length / RELAY_FANOUT);
        const chunks = Array.from({ length: RELAY_FANOUT }, (_, i) =>
          entries.slice(i * size, (i + 1) * size),
        ).filter((chunk) => chunk.length > 0);
        const done = yield* Effect.forEach(chunks, (chunk, i) => child(`/${i}`, chunk), {
          concurrency: RELAY_FANOUT,
        });
        return done.flat();
      }
      const only = entries.length === 1 ? entries[0]! : undefined;
      if (only !== undefined && "path" in only) {
        // One path: list it, and work through what it lists here.
        const next = yield* listed(pass, only.path, until, tally);
        if (next === undefined) return [false];
        yield* Effect.logDebug(
          `${work.label} relay-listed ${JSON.stringify({ name, path: only.path, entries: next.length })}`,
        );
        return [(yield* through(name, pass, next, tally)).every(Boolean)];
      }
      return yield* Effect.forEach(
        entries,
        (entry, i) =>
          "path" in entry
            ? Effect.map(child(`.${i}`, [entry]), (done) => done[0] === true)
            : item(pass, entry.ref, until, tally),
        { concurrency: RELAY_FANOUT },
      );
    });

  /**
   * The entries a run's root paces its passes over: `roots` listed level by
   * level until there are at least {@link FRONTIER_SIZE} of them (or nothing
   * left to list). Many small entries let the root steer its load finely.
   */
  const frontier = (
    pass: P,
    roots: ReadonlyArray<Entry<Item>>,
    until: number,
    size: number = FRONTIER_SIZE,
    expand: (path: string) => boolean = () => true,
  ) =>
    Effect.gen(function* () {
      let level: ReadonlyArray<Entry<Item>> = roots;
      const listable = (entry: Entry<Item>) => "path" in entry && expand(entry.path);
      while (level.length < size && level.some(listable)) {
        const next: Array<Entry<Item>> = [];
        const listings = yield* Effect.forEach(
          level,
          (entry): Effect.Effect<ReadonlyArray<Entry<Item>> | undefined> =>
            "path" in entry && listable(entry)
              ? listed(pass, entry.path, until)
              : Effect.succeed([entry]),
          { concurrency: RELAY_FANOUT },
        );
        for (const listing of listings) {
          if (listing === undefined) return undefined;
          next.push(...listing);
        }
        level = next;
      }
      return level;
    });

  return { run, frontier };
};

export type Relay<P extends Pass, Item> = ReturnType<typeof makeRelay<P, Item>>;

// ---------------------------------------------------------------- runs

/** How far a run has got, for whoever waits on it to report. */
export interface Progress {
  readonly target: string;
  readonly phase: string;
  /** The frontier entries this phase works through, and how many are done. */
  readonly subtrees: number;
  readonly done: number;
  /** Items done in this phase. */
  readonly instances: number;
  /** Passes so far: a pass that isn't done in time is followed by another. */
  readonly passes: number;
  /** Calls Cloudflare refused for the account's load: the run backs off when it does. */
  readonly refused: number;
  /** When the run began, and when it last moved, in epoch milliseconds. */
  readonly startedAt?: number;
  readonly updatedAt?: number;
  /** The last call it gave up on, if any, and why. */
  readonly lastError?: string;
}

/** A run's state at its root: what it was started with, and its phase. */
export interface RunState<Plan> {
  readonly plan: Plan;
  readonly phase: string;
  /** Passes in a row that weren't done: the next waits longer. */
  readonly misses?: number;
  /** How many entries it works through at once. */
  readonly window?: number;
}

/** Entries a run's root starts with at once: it grows to all of them while the account takes the load. */
const RUN_WINDOW = 16;

/** Calls a run's root keeps out at once: one object runs at most six. */
const RUN_CALLS = 6;

/** How a run turns its state into passes. */
export interface RunWork<Plan, P extends Pass, Item> {
  readonly label: string;
  /** The phase a new run starts in. */
  readonly firstPhase: string;
  /** The phase after `state`'s, once it is done: `complete` when there is none. */
  readonly nextPhase: (state: RunState<Plan>) => string;
  /** The pass for `state`, answering by `deadline`. */
  readonly pass: (target: string, state: RunState<Plan>, deadline: number) => P;
  /** What a pass starts from: listed into the frontier. */
  readonly roots: (pass: P, state: RunState<Plan>) => ReadonlyArray<Entry<Item>>;
  /**
   * How many entries the root lists its roots into before it paces them, at
   * least (default 512). A run whose roots are already a fine split (pages
   * of items) sets 0, and paces them as they are.
   */
  readonly frontierSize?: number;
  /**
   * Which paths the root lists into its frontier (default every one). A path
   * it leaves stays one entry: a subtree the relays list and split.
   */
  readonly expand?: (path: string) => boolean;
  /** Whether a run already started with `started` serves one asked for with `asked`. */
  readonly samePlan: (started: Plan, asked: Plan) => boolean;
}

/** What starting a run answers. */
export type Begin<Plan> =
  | { readonly status: "started" | "complete" }
  /** Started with another plan: it reads what `started` says, not what was asked. */
  | { readonly status: "changed"; readonly started: Plan };

/**
 * The root of a run: it drives passes of a relay tree from its own jobs, phase
 * after phase. Each pass is repeated until it is done.
 */
export const makeRun = <Plan, P extends Pass, Item>(
  storage: Storage,
  jobs: Jobs,
  relay: Relay<P, Item>,
  describe: (entry: Entry<Item>) => string,
  run: RunWork<Plan, P, Item>,
  options: {
    /** How long a pass keeps at it before it answers (0: one try at everything). */
    readonly waitMillis: number;
    /** How long before a pass that wasn't done runs again, doubling each time up to 30s. */
    readonly againMillis: number;
  },
) => {
  const enc = encodeURIComponent;
  const stateKey = (target: string) => `run:${enc(target)}`;
  const getState = (target: string) => storage.get<RunState<Plan>>(stateKey(target));
  const progressKey = (target: string) => `prog:${enc(target)}`;
  const getProgress = (target: string) => storage.get<Progress>(progressKey(target));

  /** A frontier entry's mark that it is done in a phase: a pass that runs again skips it. */
  const doneKey = (target: string, phase: string, entry: Entry<Item>) =>
    `rd:${enc(target)}:${phase}:${describe(entry)}`;

  const drive = (target: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const state = yield* getState(target);
      if (state === undefined || state.phase === "complete") return;
      const started = yield* Clock.currentTimeMillis;
      const deadline = started + options.waitMillis;
      // One try at everything: every round runs in this pass, whatever the clock says.
      const quiet = options.waitMillis <= 0;
      const pass = run.pass(target, state, deadline);
      const entries = yield* relay.frontier(
        pass,
        run.roots(pass, state),
        deadline,
        run.frontierSize,
        run.expand,
      );
      const todo: Array<Entry<Item>> = [];
      for (const entry of entries ?? [])
        if ((yield* storage.get(doneKey(target, state.phase, entry))) === undefined)
          todo.push(entry);
      // What a waiter reports: kept apart from the state, written as it moves.
      const before = yield* getProgress(target);
      let progress: Progress = {
        target,
        phase: state.phase,
        subtrees: entries?.length ?? before?.subtrees ?? 0,
        done: (entries?.length ?? 0) - todo.length,
        instances: before?.phase === state.phase ? before.instances : 0,
        passes: (before?.phase === state.phase ? before.passes : 0) + 1,
        refused: before?.refused ?? 0,
        startedAt: before?.startedAt ?? started,
        updatedAt: started,
        ...(before?.lastError === undefined ? {} : { lastError: before.lastError }),
      };
      yield* storage.put({ [progressKey(target)]: progress });
      // Up to `window` entries out at once, in six calls (one object runs at most six at
      // once), each handing the relay tree its share; a new call as each one answers, with
      // what was given back sent again later. Like TCP's congestion window, `window` doubles
      // while the account takes the load, then grows slowly, and halves (once per window)
      // when Cloudflare refuses calls.
      let window = state.window ?? RUN_WINDOW;
      let growing = state.window === undefined;
      const queue = [...todo];
      let active = 0;
      let calls = 0;
      let refused = 0;
      let done = entries !== undefined;
      let cutAt = 0;
      const finished = yield* Queue.unbounded<{
        readonly batch: ReadonlyArray<Entry<Item>>;
        readonly result: Result;
        readonly launched: number;
      }>();
      while (queue.length > 0 || active > 0) {
        const open = quiet || (yield* Clock.currentTimeMillis) < deadline;
        while (open && active < RUN_CALLS && queue.length > 0) {
          const batch = queue.splice(0, Math.max(1, Math.round(window / RUN_CALLS)));
          const launched = yield* Clock.currentTimeMillis;
          const name = `${state.phase}-${state.misses ?? 0}/${calls++}`;
          yield* Effect.forkChild(
            relay
              .run(name, pass, batch)
              .pipe(Effect.flatMap((result) => Queue.offer(finished, { batch, result, launched }))),
          );
          active += 1;
        }
        if (active === 0) break;
        const { batch, result, launched } = yield* Queue.take(finished);
        active -= 1;
        refused += result.refused;
        const marks: Record<string, true> = {};
        const back: Array<Entry<Item>> = [];
        batch.forEach((entry, i) => {
          if (result.done[i] === true) marks[doneKey(target, state.phase, entry)] = true;
          else back.push(entry);
        });
        progress = {
          ...progress,
          done: progress.done + Object.keys(marks).length,
          instances: progress.instances + (result.instances ?? 0),
          refused: progress.refused + result.refused,
          updatedAt: yield* Clock.currentTimeMillis,
          ...(result.failure === undefined ? {} : { lastError: result.failure }),
        };
        yield* storage.put({ ...marks, [progressKey(target)]: progress });
        if (result.refused > 0) {
          growing = false;
          if (launched >= cutAt) {
            window = Math.max(1, window / 2);
            cutAt = yield* Clock.currentTimeMillis;
          }
        } else {
          const step = batch.length;
          window = Math.min(todo.length, growing ? window + step : window + (step * step) / window);
        }
        if (back.length === 0) continue;
        // One try at everything: what wasn't done waits for the next pass.
        if (quiet) {
          done = false;
          continue;
        }
        queue.push(...back);
        // Nothing went through: wait a little before sending it again.
        if (back.length === batch.length)
          yield* Effect.sleep(`${yield* backoff(1, 1_000, 5_000)} millis`);
      }
      if (queue.length > 0) done = false;
      window = Math.max(1, Math.round(window));
      yield* Effect.logInfo(
        `${run.label} run-pass ${target} ${state.phase} done=${done} subtrees=${todo.length} window=${window} refused=${refused} in ${(yield* Clock.currentTimeMillis) - started}ms`,
      );
      if (!done) {
        const misses = (state.misses ?? 0) + 1;
        yield* storage.put({ [stateKey(target)]: { ...state, misses, window } });
        return yield* jobs.schedule(
          `drive:${target}`,
          Math.min(RELAY_RETRY_MAX_MS, options.againMillis * 2 ** (misses - 1)),
        );
      }
      const phase = run.nextPhase(state);
      yield* storage.put({
        [stateKey(target)]: { plan: state.plan, phase, window } satisfies RunState<Plan>,
        [progressKey(target)]: {
          ...progress,
          phase,
          updatedAt: yield* Clock.currentTimeMillis,
        } satisfies Progress,
      });
      if (phase !== "complete") yield* jobs.schedule(`drive:${target}`, 0);
      else yield* clearPrefix(`rd:${enc(target)}:`);
    });

  const clearPrefix = (prefix: string) =>
    Effect.gen(function* () {
      while (true) {
        const rows = yield* storage.list({ prefix, limit: 128 });
        if (rows.length === 0) return;
        yield* storage.delete(rows.map(([key]) => key));
      }
    });

  return {
    begin: (target: string, plan: Plan) =>
      storage.exclusive(
        Effect.gen(function* () {
          const state = yield* getState(target);
          if (state !== undefined) {
            // The first plan stands: a run works through one plan, start to finish.
            if (!run.samePlan(state.plan, plan))
              return { status: "changed", started: state.plan } satisfies Begin<Plan>;
            return {
              status: state.phase === "complete" ? "complete" : "started",
            } satisfies Begin<Plan>;
          }
          yield* storage.put({
            [stateKey(target)]: { plan, phase: run.firstPhase } satisfies RunState<Plan>,
          });
          yield* jobs.schedule(`drive:${target}`, 0);
          return { status: "started" } satisfies Begin<Plan>;
        }),
      ),
    phase: (target: string) =>
      Effect.map(getState(target), (state): string => state?.phase ?? "unknown"),
    /** How far the run has got; its phase is the run's own, so it never reads ahead of it. */
    progress: (target: string) =>
      Effect.gen(function* () {
        const phase = (yield* getState(target))?.phase ?? "unknown";
        const progress = yield* getProgress(target);
        return {
          target,
          subtrees: 0,
          done: 0,
          instances: 0,
          passes: 0,
          refused: 0,
          ...progress,
          phase,
        } satisfies Progress;
      }),
    /** Run a scheduled job by its id. */
    run: (id: string) => (id.startsWith("drive:") ? drive(id.slice("drive:".length)) : Effect.void),
  };
};
