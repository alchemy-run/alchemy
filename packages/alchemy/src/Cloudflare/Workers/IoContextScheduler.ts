import type * as Fiber from "effect/Fiber";
import * as Scheduler from "effect/Scheduler";

/**
 * The IoContext-owning task currently executing, if it is one of ours.
 * Module-global: there is exactly one JavaScript thread per isolate, so at
 * any instant at most one owner's task is on the stack.
 */
let active: IoContextScheduler | undefined;

/**
 * An Effect {@link Scheduler.Scheduler} pinned to one workerd IoContext —
 * a Durable Object actor or a Worker event.
 *
 * workerd pins I/O objects (storage, sockets, request/response bodies) to
 * the context that created them; touching them from another context dies
 * with "Cannot perform I/O on behalf of a different Durable Object /
 * request". Effect fibers, however, wake each other *synchronously* inside
 * the waker's JavaScript task: completing a `Deferred`, opening a `Latch`
 * (`Effect.cached`), releasing a `Semaphore`, or offering to a `Queue`
 * resumes every waiter right there. When two actors in one isolate share
 * such a primitive — anything built by the isolate-lifetime layer, e.g. a
 * cached D1 schema ensure — actor B's fiber ends up running inside actor
 * A's timer callback and its next `state.storage.put` throws.
 *
 * This scheduler makes a context's fibers refuse to run anywhere but at
 * home:
 *
 * - {@link shouldYield} is `true` whenever the current synchronous task is
 *   not one this scheduler is driving (a foreign context, or an unknown
 *   one such as a promise continuation). The fiber run loop consults it
 *   before every operation, so a fiber resumed on foreign ground yields
 *   before it performs any I/O.
 * - The yielded fiber is re-dispatched through a promise continuation that
 *   was registered *inside the owning context*. workerd
 *   (`handle_cross_request_promise_resolution`, forced on by
 *   `Compatibility.ts`) schedules such a continuation back into its origin
 *   context regardless of which context resolved the promise — that is the
 *   only sanctioned way to re-enter a context from outside it.
 *
 * The one-shot trampoline is re-armed from inside its own drain, so the
 * registration always happens at home. {@link enter} marks a synchronous
 * run as ours; the bridges wrap their fiber launches with it.
 */
export class IoContextScheduler extends Scheduler.MixedScheduler {
  readonly #pending: Array<{ f: () => void; cancelled: boolean }> = [];
  /** Resolves the armed trampoline promise; `undefined` once fired. */
  #release: (() => void) | undefined;
  /** The keep-alive interval, when requested (see the constructor). */
  #keepAlive: ReturnType<typeof setInterval> | undefined;
  #closed = false;

  /**
   * Must be constructed *inside* the owning context (the DO constructor or
   * the event handler) — the first trampoline is armed here.
   *
   * `keepAlive` holds a timer in the owning context for the scheduler's
   * lifetime. A *Worker request* is subject to workerd's hang detector: the
   * moment the thread idles while the request has no pending I/O event
   * (`IoContext::PendingEvent` — timers and in-flight I/O register one,
   * promises and `waitUntil` do not) the request is aborted with "code had
   * hung and would never generate a response". A fiber parked on a latch
   * that another request will open is exactly that state, so without the
   * timer the request dies before the trampoline ever gets to re-enter it.
   * The price is that a request whose handler genuinely never settles is
   * no longer caught by that detector while the event is open. Actors are
   * exempt from hang detection ("different requests to the same Actor are
   * explicitly allowed to resolve each other's promises") — the DO bridge
   * does not ask for it.
   */
  constructor(options?: { readonly keepAlive?: boolean }) {
    // `this` is not available until `super` returns; the dispatcher only
    // calls the function later, so forward through a binding set right after.
    let self!: IoContextScheduler;
    super("async", (f) => self.#schedule(f));
    self = this;
    if (options?.keepAlive) {
      this.#keepAlive = setInterval(() => {}, 30_000);
    }
    this.#arm();
  }

  /** Register a fresh one-shot continuation from inside the owning context. */
  #arm() {
    if (this.#closed) return;
    new Promise<void>((resolve) => {
      this.#release = resolve;
    }).then(this.#drain);
  }

  readonly #drain = () => {
    // Re-arm first: the registration happens here, at home, before any task
    // (which may run in a foreign context's nested wakeup) gets a chance to
    // schedule the next batch.
    this.#arm();
    const tasks = this.#pending.splice(0);
    this.enter(() => {
      for (const task of tasks) {
        if (!task.cancelled) task.f();
      }
    });
  };

  #schedule(f: () => void): () => void {
    if (this.#closed) {
      // The event is over: its context can no longer be re-entered (and
      // workerd would drop the continuation). Fall back to the runtime's
      // plain dispatch — a late fiber runs wherever it was woken, which is
      // what it did before this scheduler existed.
      const timer = setTimeout(f, 0);
      return () => clearTimeout(timer);
    }
    const task = { f, cancelled: false };
    this.#pending.push(task);
    if (this.#release !== undefined) {
      const release = this.#release;
      this.#release = undefined;
      release();
    }
    return () => {
      task.cancelled = true;
    };
  }

  /**
   * Run `f` synchronously as this context's own task. Bridges wrap the
   * synchronous head of every fiber launch (`Effect.runPromise*` starts the
   * fiber inline) so the fiber does not yield before its first operation.
   */
  enter<A>(f: () => A): A {
    const previous = active;
    active = this;
    try {
      return f();
    } finally {
      active = previous;
    }
  }

  /**
   * The owning event has produced its result: stop re-arming, flush what is
   * queued (it still runs at home, in the final drain), and drop the
   * keep-alive so the event can complete.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const release = this.#release;
    this.#release = undefined;
    release?.();
    if (this.#keepAlive !== undefined) {
      clearInterval(this.#keepAlive);
      this.#keepAlive = undefined;
    }
  }

  override shouldYield(fiber: Fiber.Fiber<unknown, unknown>): boolean {
    // Once closed there is no home to return to: the plain-dispatch fallback
    // in `#schedule` runs fibers outside `enter`, so insisting on `active ===
    // this` here would make every resumption yield straight back into
    // another timer — a livelock that never lets a late fiber (e.g. a scope
    // finalizer interrupting the telemetry batch loop) finish.
    if (this.#closed) return super.shouldYield(fiber);
    return active !== this || super.shouldYield(fiber);
  }
}
