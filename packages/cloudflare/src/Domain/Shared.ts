import * as FanOut from "@alchemy.run/domain/FanOut";
import type * as cf from "@cloudflare/workers-types";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import {
  DurableObject as CloudflareDurableObject,
  type DurableObjectJurisdiction,
} from "../Workers/DurableObject.ts";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";
import * as Move from "../Workers/internal/DurableObjectMove.ts";
import { makeRpcStub } from "../Workers/Rpc.ts";
import { Worker as CloudflareWorker, type Worker } from "../Workers/Worker.ts";
import { WorkerEnvironment } from "../Workers/WorkerRuntime.ts";
import { sleep, task, Workflow, type WorkflowImpl } from "../Workflows/Workflow.ts";
import { backfillRuntime } from "./Runtime.ts";
import { MIGRATION_WORKFLOW } from "./Version.ts";

/**
 * Domain version 1 hosts every object of every model on a Worker in one
 * Durable Object class. An object's name is its route and key,
 * `Billing.AccountAggregate/a-1`: the route names the model and the
 * definition, as each class did in version 0, so models stay isolated.
 *
 * A Worker upgraded from version 0 keeps each old class live, running the same
 * code, until its objects have moved (see `DurableObjectMove.ts`). Callers
 * always address the new object. Until it owns its key's data, it forwards
 * every call to the old object, which keeps serving, while it copies the old
 * object's storage in the background; then it seals the old object and takes
 * over in one short step. The first call to a key starts its move; a deploy's
 * {@link MIGRATION_WORKFLOW} moves the rest. See `Version.ts` for when the old
 * classes are deleted.
 */
export const SHARED_CLASS = "AlchemyDomain";

/** The key an object listed itself under in the backfill directory. */
export const ID_KEY = "bf:id";

/** How long one alarm of a new object copies before it schedules the next. */
const COPY_BUDGET_MS = 20_000;

/** An old object that doesn't know the move: it still runs the code from before the deploy. */
const STALE = /not found on Durable Object/;
/** How long an old object on older code is left alone: past the ~10s idle that moves it to new code. */
const STALE_IDLE_MS = 15_000;
/** How long a call waits, at most, for the old object to move to the deployed code. */
const STALE_HOLD_MS = 60_000;

interface Stub {
  readonly [method: string]: (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown>;
}

export interface Namespace {
  readonly getByName: (name: string) => any;
  readonly jurisdiction: (jurisdiction: DurableObjectJurisdiction) => Namespace;
}

/** What an instance's methods and constructor run with. */
type InstanceServices = DurableObjectState | RuntimeContext | Scope.Scope;

export type ObjectImpl = Effect.Effect<
  Effect.Effect<Record<string, unknown>, never, InstanceServices>,
  never,
  DurableObjectState
>;

const declare = CloudflareDurableObject as unknown as (
  name: string,
  impl: ObjectImpl,
) => Effect.Effect<Namespace, never, Worker>;

/** A move of an old object's storage that didn't complete; the move is tried again. */
export class DomainMoveFailed extends Data.TaggedError("DomainMoveFailed")<{
  readonly message: string;
}> {}

const failed = (what: string) => (cause: unknown) =>
  new DomainMoveFailed({
    message: `${what}: ${
      typeof cause === "object" && cause !== null && "message" in cause
        ? String(cause.message)
        : String(cause)
    }`,
  });

/** The objects of one route, in the shared class. */
const routeView = (namespace: Namespace, route: string): Namespace => ({
  getByName: (key: string) => namespace.getByName(`${route}/${key}`),
  jurisdiction: (jurisdiction) => routeView(namespace.jurisdiction(jurisdiction), route),
});

/** An object's route and key, from its name. */
const parseName = (name: string | undefined) => {
  const slash = name === undefined ? -1 : name.indexOf("/");
  return slash < 0 ? undefined : { route: name!.slice(0, slash), key: name!.slice(slash + 1) };
};

interface Classes {
  /** Every route this Worker's code hosts, and its implementation. */
  readonly routes: Map<string, ObjectImpl>;
  /** Each route's version 0 class, while the code still moves its objects. */
  readonly movers: Map<string, string>;
  readonly namespace: Namespace;
  /** The migration Workflow's name, as deployed. */
  readonly workflowName: unknown;
  readonly env: Record<string, any> | undefined;
}

/** One set of classes per Worker. */
const workers = new WeakMap<object, Classes>();

/** The shared class of the host Worker, declared on first use. */
export const sharedClasses = Effect.fn(function* () {
  const host = yield* CloudflareWorker;
  let classes = workers.get(host);
  if (classes === undefined) {
    const routes = new Map<string, ObjectImpl>();
    const movers = new Map<string, string>();
    const namespace = yield* declare(
      SHARED_CLASS,
      router(routes, movers, () => classes!),
    );
    const workflow = (yield* Workflow(
      MIGRATION_WORKFLOW,
      Effect.succeed(migration) as unknown as Effect.Effect<WorkflowImpl<any, any, unknown>>,
    )) as { readonly workflowName: unknown };
    classes = {
      routes,
      movers,
      namespace,
      workflowName: workflow.workflowName,
      // The Worker's bindings, at runtime: the old classes' among them.
      env: Option.getOrUndefined(yield* Effect.serviceOption(WorkerEnvironment)),
    };
    workers.set(host, classes);
    // The migration run's root and relays: see `migration`.
    routes.set(MIGRATION_ROUTE, migrationObject(classes));
  }
  const shared = classes;
  return {
    /** The migration Workflow's name, as deployed: for the deploy's migration run. */
    workflowName: shared.workflowName,
    /** Each hosted route's version 0 class. */
    movers: shared.movers,
    /**
     * Host `route`'s objects in the shared class. `legacy` is the class they
     * had in version 0: declared too, running the same code, so a Worker
     * upgraded from it moves their storage over.
     */
    object: (route: string, impl: ObjectImpl, legacy?: string) =>
      Effect.gen(function* () {
        shared.routes.set(route, impl);
        // At deploy time every version 0 class is declared, and the upload keeps
        // those still holding objects (see `Version.keptMovers`). At runtime only
        // those the upload kept have a binding: declaring another would fail.
        if (
          legacy !== undefined &&
          !shared.movers.has(route) &&
          (!globalThis.__ALCHEMY_RUNTIME__ || shared.env?.[legacy] !== undefined)
        ) {
          shared.movers.set(route, legacy);
          yield* declare(legacy, source(shared, route, impl));
        }
        return routeView(shared.namespace, route);
      }),
    /** A route's objects, if this code hosts it. */
    bound: (route: string): Namespace | undefined =>
      shared.routes.has(route) ? routeView(shared.namespace, route) : undefined,
  };
});

/** The old object of `key`, while the Worker still has its class. */
const legacyStub = (
  classes: Classes,
  route: string,
  key: string,
  jurisdiction: string | undefined,
): Stub | undefined => {
  const legacy = classes.movers.get(route);
  const namespace = legacy === undefined ? undefined : classes.env?.[legacy];
  if (namespace === undefined || typeof namespace.getByName !== "function") return undefined;
  const scoped = jurisdiction === undefined ? namespace : namespace.jurisdiction(jurisdiction);
  return makeRpcStub<Stub>(scoped.getByName(key));
};

/** The new object of `key` in the shared class. */
const sharedStub = (
  classes: Classes,
  route: string,
  key: string,
  jurisdiction: DurableObjectJurisdiction | undefined,
): Stub => {
  const namespace =
    jurisdiction === undefined ? classes.namespace : classes.namespace.jurisdiction(jurisdiction);
  return namespace.getByName(`${route}/${key}`) as Stub;
};

/** The old object, as the new one calls it during a move. */
const sourceCalls = (from: Stub): Move.SourceCalls => {
  const call = <A>(what: string, effect: Effect.Effect<unknown, unknown>) =>
    effect.pipe(Effect.mapError(failed(what))) as Effect.Effect<A, DomainMoveFailed>;
  return {
    begin: () => call("starting the move", from.domainMoveBegin!()),
    snapshot: (after) => call("copying", from.domainMoveSnapshot!(after)),
    changes: (after) => call("catching up", from.domainMoveChanges!(after)),
    seal: () => call("sealing the old object", from.domainMoveSeal!()),
    sql: (at) => call("copying its tables", from.domainMoveSql!(at)),
    finish: () => call("emptying the old object", from.domainMoveFinish!()),
  };
};

/** Members the runtime looks up on an instance that are not calls to forward. */
const UNFORWARDED = new Set(["then", "toJSON", "constructor", "pipe"]);

/**
 * An instance whose members are looked up when they are used: `members()`
 * decides, so one object can change what it does (forward, or serve) while it
 * lives. The bridge checks members with `Object.hasOwn`, which this answers.
 */
const dynamic = (members: (prop: string) => unknown): Record<string, unknown> =>
  new Proxy({} as Record<string, unknown>, {
    get: (_, prop) =>
      typeof prop !== "string" || UNFORWARDED.has(prop) ? undefined : members(prop),
    getOwnPropertyDescriptor: (_, prop) => {
      if (typeof prop !== "string" || UNFORWARDED.has(prop)) return undefined;
      const value = members(prop);
      return value === undefined
        ? undefined
        : { value, configurable: true, enumerable: false, writable: false };
    },
  });

/** Forward a member to another object's stub: a method call, or `fetch`. */
const forwardTo = (stub: Effect.Effect<Stub | undefined>, prop: string): unknown =>
  prop === "fetch"
    ? Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const target = yield* stub;
        if (target === undefined)
          return HttpServerResponse.text("This object moved and has no name", { status: 410 });
        return yield* (
          target as unknown as {
            fetch: (
              request: HttpServerRequest,
            ) => Effect.Effect<HttpServerResponse.HttpServerResponse, unknown>;
          }
        )
          .fetch(request)
          .pipe(Effect.orDie);
      })
    : (...args: ReadonlyArray<unknown>) =>
        Effect.flatMap(stub, (target) =>
          target === undefined
            ? Effect.die(new Error(`an object without a name can't forward ${prop}`))
            : target[prop]!(...args),
        );

/** WebSocket and alarm members that a forwarding object handles itself. */
const LOCAL = new Set(["webSocketMessage", "webSocketClose", "webSocketError"]);

/**
 * The shared class: each object runs its route's implementation. A route
 * whose version 0 class is still on the Worker moves its key's data first:
 * see the module's description.
 */
const router = (
  routes: Map<string, ObjectImpl>,
  movers: Map<string, string>,
  classes: () => Classes,
): ObjectImpl =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    // At deploy time the class is declared with a placeholder state: no object, no route.
    const parsed = parseName(state.id?.name);
    const impl = parsed === undefined ? undefined : routes.get(parsed.route);
    // At deploy time: nothing to construct.
    if (parsed === undefined) return Effect.succeed({});
    // A route this code doesn't host: the object runs on code from before the
    // deploy that added it (a new view generation's objects are new routes in
    // an existing class, and an object moves to new code only once idle), or
    // after the one that removed it. It keeps its data, and answers every call
    // so that callers try again later, as they do for any object on older code.
    if (impl === undefined)
      return Effect.succeed(
        dynamic((prop) =>
          prop === "alarm" || LOCAL.has(prop)
            ? () => Effect.void
            : prop === "fetch"
              ? Effect.succeed(
                  HttpServerResponse.text(`${parsed.route} isn't in the code this runs yet`, {
                    status: 503,
                  }),
                )
              : () => Effect.die(new Error(`${parsed.route} isn't in the code this runs yet`)),
        ),
      );
    const inner = yield* impl;
    const from = movers.has(parsed.route)
      ? legacyStub(classes(), parsed.route, parsed.key, state.id.jurisdiction)
      : undefined;
    return Effect.gen(function* () {
      // Built now, while the object is constructed, as always: it reads its
      // storage lazily, so it serves the copied data once the move is done.
      const instance = yield* inner;
      const raw = state.raw.storage;
      const owned = () => from === undefined || Move.moveState(raw)?.phase === "owned";
      if (owned())
        return {
          ...instance,
          domainMove: () => Effect.succeed(true),
          domainMoveState: () => Effect.succeed({ phase: "owned" }),
        };
      const calls = sourceCalls(from!);

      const name = `${parsed.route}/${parsed.key}`;
      /** One step at a time: an alarm and the migration's call never copy at once. */
      let driving = false;
      let failures = 0;
      let lastError: string | undefined;
      /**
       * Until when the old object is left alone: it still runs the code from
       * before the deploy (Cloudflare moves an object to new code only once
       * it has been idle for about ten seconds), and every call would keep it
       * there. Calls to this key wait meanwhile, rather than keep it busy.
       */
      let staleUntil = 0;
      /**
       * Copy for up to `budget`; once caught up, take over with this object's
       * own calls held. A failure never stops the move: it logs, and the alarm
       * tries again later, waiting longer each time (Cloudflare's own alarm
       * retries give up after a few).
       */
      const step = (budget: number) =>
        Effect.suspend(() => {
          if (driving || owned() || Date.now() < staleUntil) return Effect.void;
          driving = true;
          return Effect.gen(function* () {
            yield* Move.begin(raw, calls);
            const ready = yield* Move.copyFor(raw, calls, budget);
            yield* Effect.logDebug(
              `domain move ${name} ${JSON.stringify(Move.moveState(raw))} ready=${ready}`,
            );
            if (ready)
              yield* state
                .blockConcurrencyWhile(() => Effect.exit(Move.takeOver(raw, calls)))
                .pipe(Effect.flatten);
            failures = 0;
            // Not done: carry on in the next alarm.
            if (!owned()) yield* Effect.promise(() => raw.setAlarm(Date.now()));
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                failures += 1;
                lastError = Cause.pretty(cause).slice(0, 2000);
                if (STALE.test(lastError)) {
                  // On older code: leave it idle long enough to move to the deployed code.
                  staleUntil = Date.now() + STALE_IDLE_MS;
                  yield* Effect.promise(() => raw.setAlarm(staleUntil + 100));
                  return;
                }
                yield* Effect.logWarning(`domain move ${name} failed (${failures})`, cause);
                const wait = Math.min(30_000, 250 * 2 ** Math.min(failures, 7));
                yield* Effect.promise(() => raw.setAlarm(Date.now() + wait));
              }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                driving = false;
              }),
            ),
          );
        });

      /**
       * While the old object is left alone, wait; then start the move here (the
       * old object now runs the deployed code, or is left alone again). Bounded:
       * past {@link STALE_HOLD_MS} a call goes to the old object anyway.
       */
      const holdWhileStale = Effect.gen(function* () {
        const until = Date.now() + STALE_HOLD_MS;
        while (!owned() && Date.now() < staleUntil && Date.now() < until) {
          yield* Effect.sleep("250 millis");
          if (Date.now() >= staleUntil) yield* step(0);
        }
      });

      /** Make sure something drives the move: a pending alarm, or a step under way. */
      const ensureDriven = Effect.gen(function* () {
        if (driving || owned()) return;
        if ((yield* Effect.promise(() => raw.getAlarm())) === null)
          yield* Effect.promise(() => raw.setAlarm(Date.now()));
      });

      // Start the move as soon as the object is first used: its alarm drives it.
      yield* ensureDriven;

      const forwarded = Effect.succeed(from);
      return dynamic((prop) => {
        // Where the move has got to: for tests and operators.
        if (prop === "domainMoveState")
          return () =>
            Effect.sync(() => ({
              ...(owned() ? { phase: "owned" } : (Move.moveState(raw) ?? { phase: "none" })),
              driving,
              failures,
              ...(lastError === undefined ? {} : { lastError }),
            }));
        if (owned()) {
          if (prop === "domainMove") return () => Effect.succeed(true);
          return (instance as Record<string, unknown>)[prop];
        }
        switch (prop) {
          case Move.OwnsAlarmCallbacks:
            return true;
          case "alarm":
            return () => step(COPY_BUDGET_MS);
          // The migration's call: move now, in this call, and answer once it's
          // done or `waitMillis` passes. An alarm already copying carries on.
          case "domainMove":
            return (waitMillis: number) =>
              Effect.gen(function* () {
                const until = (yield* Clock.currentTimeMillis) + waitMillis;
                yield* step(waitMillis);
                while (!owned() && (yield* Clock.currentTimeMillis) < until) {
                  yield* ensureDriven;
                  yield* Effect.sleep("100 millis");
                }
                return owned();
              });
          default: {
            // Until the move is done, the old object serves: it holds the data.
            if (LOCAL.has(prop)) return undefined;
            const forward = forwardTo(forwarded, prop);
            // Every call makes sure the move is driven (a stalled one restarts),
            // and waits while the old object is left to move to the deployed code.
            const before = Effect.andThen(ensureDriven, holdWhileStale);
            return typeof forward === "function"
              ? (...args: ReadonlyArray<unknown>) =>
                  Effect.andThen(
                    before,
                    (forward as (...a: ReadonlyArray<unknown>) => Effect.Effect<unknown>)(...args),
                  )
              : Effect.andThen(before, forward as Effect.Effect<unknown>);
          }
        }
      });
    });
  });

/**
 * A version 0 class while its objects move: it serves with the same code as
 * the new one, and logs its writes for the move once one begins. Once sealed,
 * every call goes to the new object of the same key.
 */
const source = (classes: Classes, route: string, impl: ObjectImpl): ObjectImpl =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    const raw = state.raw?.storage;
    // At deploy time the class is declared with a placeholder state.
    if (raw?.kv === undefined) return yield* impl;
    // Count its work from now on, and keep logging a move already under way.
    Move.watchSource(raw);
    const inner = yield* impl;
    return Effect.gen(function* () {
      const instance = (yield* inner) as Record<string, unknown>;
      const key = Effect.gen(function* () {
        // An object created before Durable Objects kept their names: the key it stored.
        return state.id.name ?? (yield* Effect.promise(() => raw.get<string>(ID_KEY))) ?? undefined;
      });
      const target = Effect.map(key, (name) =>
        name === undefined
          ? undefined
          : sharedStub(
              classes,
              route,
              name,
              state.id.jurisdiction as DurableObjectJurisdiction | undefined,
            ),
      );
      const moves: Record<string, unknown> = {
        domainName: () => Effect.map(key, (name) => name ?? null),
        domainMoveBegin: () => Move.beginSource(raw),
        domainMoveSnapshot: (after: Move.SnapshotCursor) => Move.snapshotPage(raw, after),
        domainMoveChanges: (after: number) => Move.changesPage(raw, after),
        domainMoveSeal: () => Move.seal(raw, () => state.raw.getWebSockets()),
        domainMoveSql: (at: Move.SqlCursor | null) => Move.sqlPage(raw, at),
        domainMoveFinish: () => Move.finish(raw),
      };
      return dynamic((prop) => {
        if (prop in moves) return moves[prop];
        if (Move.isSealing(raw)) {
          // Moved: the new object answers. Its stored callbacks moved with it.
          if (prop === Move.OwnsAlarmCallbacks) return true;
          if (prop === "alarm") return () => Effect.void;
          return LOCAL.has(prop) ? undefined : forwardTo(target, prop);
        }
        const member = instance[prop];
        // A call under way: a seal waits for it.
        if (typeof member === "function")
          return (...args: ReadonlyArray<unknown>) =>
            Move.counted(
              raw,
              (member as (...a: ReadonlyArray<unknown>) => Effect.Effect<unknown>)(...args),
            );
        if (Effect.isEffect(member)) return Move.counted(raw, member);
        return member;
      });
    });
  });

// ---------------------------------------------------------------- the migration run

/**
 * The migration run's route in the shared class. Its root (`run:<target>`)
 * holds the objects to move, page by page, and drives a `FanOut` run over
 * them; its relays (`relay:<target>:<name>`) each move a share.
 */
const MIGRATION_ROUTE = "~migration";

/** One object to move: its old class, its route in the shared class, and its hex id. */
interface MoveItem {
  readonly c: string;
  readonly r: string;
  readonly id: string;
}

/** A pass of a migration run. */
interface MovePass extends FanOut.Pass {
  readonly target: string;
}

/** What a migration run moves: the pages of ids the deploy listed. */
export interface MovePlan {
  readonly pages: ReadonlyArray<{
    readonly n: number;
    readonly className: string;
    readonly size: number;
  }>;
}

/** A page of ids the deploy listed, as the root keeps it. */
interface StoredPage {
  readonly className: string;
  readonly route: string;
  readonly ids: ReadonlyArray<string>;
}

const pageKey = (target: string, n: string | number) => `mg:page:${target}:${n}`;
const skipKey = (target: string) => `mg:skip:${target}`;

/** How long a pass of a migration run keeps at it before the root starts another. */
const MIGRATION_PASS_MS = 5 * 60_000;

/** The root and relay objects of a migration run. */
const migrationStub = (classes: Classes, key: string) =>
  makeRpcStub<Stub>(
    (
      classes.env?.[SHARED_CLASS] as { getByName: (name: string) => unknown } | undefined
    )?.getByName(`${MIGRATION_ROUTE}/${key}`) ??
      classes.namespace.getByName(`${MIGRATION_ROUTE}/${key}`),
  );

const orDie = <A>(effect: Effect.Effect<unknown, unknown>) =>
  effect.pipe(Effect.orDie) as Effect.Effect<A>;

/**
 * Move one object: find its key (its name), and ask its new object to move
 * its data, waiting up to `waitMillis` for the flip. `skipped` for an object
 * that knows neither its name nor its key.
 */
const moveOne = (classes: Classes, item: MoveItem, waitMillis: number) =>
  Effect.gen(function* () {
    const legacy = classes.env?.[item.c];
    const shared = classes.env?.[SHARED_CLASS];
    if (legacy === undefined || shared === undefined) return "skipped" as const;
    const id = legacy.idFromString(item.id);
    const name = yield* orDie<string | null>(makeRpcStub<Stub>(legacy.get(id)).domainName!());
    if (name === null) return "skipped" as const;
    const scoped = id.jurisdiction === undefined ? shared : shared.jurisdiction(id.jurisdiction);
    const target = makeRpcStub<Stub>(scoped.getByName(`${item.r}/${name}`));
    return (yield* orDie<boolean>(target.domainMove!(waitMillis)))
      ? ("moved" as const)
      : ("pending" as const);
  });

/** How a migration run's relays list a page and move an object: see `FanOut`. */
const migrationWork = (classes: Classes): FanOut.Work<MovePass, MoveItem> => ({
  label: "move",
  list: (pass, path) =>
    orDie<FanOut.Listed<MoveItem>>(
      migrationStub(classes, `run:${pass.target}`).mgList!(pass.target, path),
    ),
  handle: (pass, item, waitMillis) =>
    Effect.flatMap(moveOne(classes, item, waitMillis), (outcome) =>
      outcome === "skipped"
        ? Effect.as(
            orDie(
              migrationStub(classes, `run:${pass.target}`).mgSkip!(pass.target, item.c, item.id),
            ),
            true,
          )
        : Effect.succeed(outcome === "moved"),
    ),
  describe: (item) => `${item.c}/${item.id}`,
  relay: (name, pass, entries) =>
    orDie<FanOut.Result>(
      migrationStub(classes, `relay:${pass.target}:${name}`).mgRelay!(name, pass, entries),
    ),
});

/** A frontier entry's name in the root's marks of what is done. */
const entryKey = (entry: FanOut.Entry<MoveItem>) =>
  "path" in entry ? `p:${entry.path}` : `i:${entry.ref.c}/${entry.ref.id}`;

interface MigrationRun {
  readonly begin: (target: string, plan: MovePlan) => Effect.Effect<FanOut.Begin<MovePlan>>;
  readonly progress: (target: string) => Effect.Effect<FanOut.Progress>;
  readonly run: (id: string) => Effect.Effect<void>;
}

/** The objects of a migration run: its root, and its relays. */
const migrationObject = (classes: Classes): ObjectImpl =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    return Effect.gen(function* () {
      const work = migrationWork(classes);
      const relay = FanOut.makeRelay(work);
      let run: MigrationRun | undefined;
      const runtime: { readonly storage: FanOut.Storage; readonly jobs: FanOut.Jobs } =
        yield* backfillRuntime({ uuidV4: () => Effect.sync(() => crypto.randomUUID()) }, (id) =>
          run!.run(id),
        );
      const makeMigrationRun = (): MigrationRun =>
        FanOut.makeRun<MovePlan, MovePass, MoveItem>(
          runtime.storage,
          runtime.jobs,
          relay,
          entryKey,
          {
            label: "move",
            firstPhase: "move",
            nextPhase: () => "complete",
            pass: (target, _, deadline) => ({ target, deadline }),
            // Each page is one entry: the root paces pages, and the relays spread a page's objects.
            roots: (pass, state) =>
              state.plan.pages.map((page) => ({ path: `${pass.target}#${page.n}` })),
            frontierSize: 0,
            samePlan: (a, b) =>
              a.pages.map((page) => `${page.className}#${page.n}`).join(",") ===
              b.pages.map((page) => `${page.className}#${page.n}`).join(","),
          },
          { waitMillis: MIGRATION_PASS_MS, againMillis: 1_000 },
        );
      run = makeMigrationRun();
      const storage = runtime.storage;
      return {
        /** Keep a page of ids the deploy listed, for a run to move. */
        mgAdd: (target: string, n: number, page: StoredPage) =>
          storage.put({ [pageKey(target, n)]: page }),
        mgBegin: (target: string, plan: MovePlan) => run!.begin(target, plan),
        mgProgress: (target: string) =>
          Effect.gen(function* () {
            const progress = yield* run!.progress(target);
            const skipped = (yield* storage.get<Record<string, number>>(skipKey(target))) ?? {};
            return { ...progress, skipped };
          }),
        /** What a path lists: the run's pages (its root), or a page's objects. */
        mgList: (target: string, path: string) =>
          Effect.gen(function* () {
            if (path === target) {
              const state = yield* storage.get<{ plan: MovePlan }>(
                `run:${encodeURIComponent(target)}`,
              );
              return {
                entries: (state?.plan.pages ?? []).map((page) => ({ path: `${target}#${page.n}` })),
              } satisfies FanOut.Listed<MoveItem>;
            }
            const page = yield* storage.get<StoredPage>(
              pageKey(target, path.slice(path.lastIndexOf("#") + 1)),
            );
            return {
              entries: (page?.ids ?? []).map((id) => ({
                ref: { c: page!.className, r: page!.route, id },
              })),
            } satisfies FanOut.Listed<MoveItem>;
          }),
        /** An object that can't be moved (it knows neither its name nor its key): its class is kept. */
        mgSkip: (target: string, className: string) =>
          storage.exclusive(
            Effect.gen(function* () {
              const skipped = (yield* storage.get<Record<string, number>>(skipKey(target))) ?? {};
              yield* storage.put({
                [skipKey(target)]: { ...skipped, [className]: (skipped[className] ?? 0) + 1 },
              });
            }),
          ),
        mgRelay: (name: string, pass: MovePass, entries: ReadonlyArray<FanOut.Entry<MoveItem>>) =>
          relay.run(name, pass, entries),
      };
    }).pipe(Effect.provideService(DurableObjectState, state));
  });

/** What the deploy asks the migration Workflow to do. */
type MigrationParams =
  /** Keep pages of ids in the run's root. */
  | {
      readonly op: "add";
      readonly target: string;
      readonly pages: ReadonlyArray<StoredPage & { readonly n: number }>;
    }
  /** Start the run, and wait until it is complete: each check's output is its progress. */
  | { readonly op: "run"; readonly target: string; readonly plan: MovePlan }
  /** A record of a complete pass over a class (see `Version.passMarker`): nothing to do. */
  | { readonly op: "mark" };

/**
 * The deploy's channel into the Worker: it hands the run its pages, then
 * starts it and waits. The run itself goes on in Durable Objects.
 */
const migration = (params: MigrationParams) =>
  Effect.gen(function* () {
    if (params.op === "mark") return {};
    const env = (yield* WorkerEnvironment) as Record<string, any>;
    const root = makeRpcStub<Stub>(
      env[SHARED_CLASS].getByName(`${MIGRATION_ROUTE}/run:${params.target}`),
    );
    const call = <A>(what: string, effect: Effect.Effect<unknown, unknown>) =>
      effect.pipe(Effect.mapError(failed(what))) as Effect.Effect<A, DomainMoveFailed>;
    if (params.op === "add") {
      for (const { n, ...page } of params.pages)
        yield* task(`add-${n}`, call("keeping a page", root.mgAdd!(params.target, n, page)), {
          retries: { limit: 10, delay: "2 seconds", backoff: "exponential" },
        });
      return {};
    }
    yield* task("begin", call("starting the run", root.mgBegin!(params.target, params.plan)), {
      retries: { limit: 10, delay: "2 seconds", backoff: "exponential" },
    });
    for (let check = 0; ; check++) {
      const progress = yield* task(
        `check-${check}`,
        call<FanOut.Progress & { readonly skipped: Record<string, number> }>(
          "reading progress",
          root.mgProgress!(params.target),
        ).pipe(Effect.map((progress) => [progress])),
        { retries: { limit: 10, delay: "2 seconds", backoff: "exponential" } },
      );
      if (progress[0]!.phase === "complete") return { progress: progress[0]! };
      // Soon at first, then less often: each check is a step (an instance has 10,000).
      yield* sleep(`wait-${check}`, `${Math.min(10_000, Math.round(500 * 1.25 ** check))} millis`);
    }
  });
