import type * as Backfill from "@alchemy.run/domain/Backfill";
import * as FanOut from "@alchemy.run/domain/FanOut";
import type { Delivery } from "@alchemy.run/domain/Platform";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
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
 * Domain version 1 hosts every object of a model in one Durable Object class,
 * named after the model: `Billing.Domain`. An object's name is its route and
 * key, `Billing.AccountAggregate/a-1`: the route names the definition, as each
 * class did in version 0. Each model has its own class, so removing a model
 * from a Worker deletes its class, and a Worker declares one class per model
 * however many definitions it has.
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
export const domainClassName = (modelName: string) =>
  `${modelName}.Domain`.replace(/[^A-Za-z0-9_.]/g, "_");

/** The key an object listed itself under in the backfill directory. */
export const ID_KEY = "bf:id";

/** How long one alarm of a new object copies before it schedules the next. */
const COPY_BUDGET_MS = 20_000;

/** An old object that doesn't know the move: it still runs the code from before the deploy. */
const STALE = /not found on Durable Object/;
/** What an old object's storage answers once its data has moved (`DurableObjectMove`). */
const MOVED = "data has moved to another object";
/** How a forwarded call came back: answered, refused by a sealed object, or on older code. */
type Forwarded = { readonly value: unknown } | { readonly sealed: true } | { readonly stale: true };
/** What a sealed old object answers a forwarded call: the new object takes over and serves. */
const SEALED = "domain object sealed: its data moved to the new object";
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

/** Declare the class `className` with `impl`, bound as `binding`. */
const declareAs = (binding: string, className: string, impl: ObjectImpl) => {
  if (binding === className) return declare(binding, impl);
  const Class = (
    CloudflareDurableObject as unknown as () => (
      name: string,
      props: { readonly className: string },
    ) => Effect.Effect<Namespace> & {
      readonly make: (impl: ObjectImpl) => Layer.Layer<never, never, Worker>;
    }
  )()(binding, { className });
  return Effect.provide(Class, Class.make(impl)) as Effect.Effect<Namespace, never, Worker>;
};

/** A class an object's data may still be on: its name, and the binding the code reaches it by. */
export interface LegacyClass {
  readonly binding: string;
  readonly className: string;
}

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
  /** The model's class, `Billing.Domain`: its name and its binding. */
  readonly className: string;
  /** Every route the model hosts, and its implementation. */
  readonly routes: Map<string, ObjectImpl>;
  /** The binding of each route's old class, while the code still moves its objects. */
  readonly movers: Map<string, string>;
  readonly namespace: Namespace;
  /** The migration Workflow's name, as deployed. */
  readonly workflowName: unknown;
  readonly env: Record<string, any> | undefined;
  /** Where the migration run's job tokens come from. */
  readonly random: Random;
  /** How a migration run finds every object of the model: set once the model is built. */
  resolver?: Resolver;
}

/**
 * How a migration run finds every object of a model without Cloudflare's
 * object listing, which lags behind recent writes: the model's directory lists
 * every aggregate and view (and, from this release on, every other object),
 * and each one's history names the consumer objects it reached.
 */
export interface Resolver {
  /** The model's class, in the model's jurisdiction. */
  readonly namespace: Namespace;
  /** The route of the model's directory nodes, `Billing.DomainDirectory`. */
  readonly directory: string;
  /**
   * The route of a directory entry's objects, and whether it is a source (an
   * aggregate or view, whose history names consumers); `undefined` for one
   * this code doesn't host.
   */
  readonly entry: (
    ref: Backfill.SourceRef,
  ) => { readonly route: string; readonly source: boolean } | undefined;
  /** A consumer's routes: its keys', and its run's (root, relays and scanners). */
  readonly consumer: (
    target: Delivery["target"],
  ) => { readonly keys: string; readonly run: string } | undefined;
  /** The routes of the streams a projection writes, keyed like the projection. */
  readonly streams: (projection: string) => ReadonlyArray<string>;
  /** The routes of every consumer's run, whose root records its history. */
  readonly runs: () => ReadonlyArray<string>;
  /** The name of a source instance's scanner in a consumer's run (see `Domain/index.ts`). */
  readonly scanner: (ref: Backfill.SourceRef) => string;
}

/** What makes job tokens: the platform's secure random source. */
export interface Random {
  readonly uuidV4: () => Effect.Effect<string>;
}

/** Each model's class, per Worker. */
const workers = new WeakMap<object, Map<string, Classes>>();
/** The migration Workflow of each Worker: one moves every model's objects. */
const migrationWorkflows = new WeakMap<object, { readonly workflowName: unknown }>();

/** The class of `modelName` on the host Worker, declared on first use. */
export const sharedClasses = Effect.fn(function* (random: Random, modelName: string) {
  const host = yield* CloudflareWorker;
  let models = workers.get(host);
  if (models === undefined) workers.set(host, (models = new Map()));
  let classes = models.get(modelName);
  if (classes === undefined) {
    const className = domainClassName(modelName);
    const routes = new Map<string, ObjectImpl>();
    const movers = new Map<string, string>();
    const namespace = yield* declare(
      className,
      router(routes, movers, () => classes!),
    );
    let workflow = migrationWorkflows.get(host);
    if (workflow === undefined) {
      workflow = (yield* Workflow(
        MIGRATION_WORKFLOW,
        Effect.succeed(migration) as unknown as Effect.Effect<WorkflowImpl<any, any, unknown>>,
      )) as { readonly workflowName: unknown };
      migrationWorkflows.set(host, workflow);
    }
    classes = {
      className,
      routes,
      movers,
      namespace,
      workflowName: workflow.workflowName,
      // The Worker's bindings, at runtime: the old classes' among them.
      env: Option.getOrUndefined(yield* Effect.serviceOption(WorkerEnvironment)),
      random,
    };
    models.set(modelName, classes);
    // The migration run's root and relays: see `migration`.
    routes.set(MIGRATION_ROUTE, migrationObject(classes));
  }
  const shared = classes;
  return {
    /** The model's class, `Billing.Domain`. */
    className: shared.className,
    /** How a migration run finds the model's objects. */
    resolve: (resolver: Resolver) =>
      Effect.sync(() => {
        shared.resolver = resolver;
      }),
    /** The migration Workflow's name, as deployed: for the deploy's migration run. */
    workflowName: shared.workflowName,
    /** Each hosted route's version 0 class. */
    movers: shared.movers,
    /**
     * Host `route`'s objects in the shared class. `legacy` are the classes
     * they may still be on: their version 0 class, and their class from
     * before versions. Each is declared too, running the same code, so a
     * Worker upgraded from either moves their storage over.
     */
    object: (route: string, impl: ObjectImpl, legacy: ReadonlyArray<LegacyClass> = []) =>
      Effect.gen(function* () {
        shared.routes.set(route, impl);
        if (shared.movers.has(route)) return routeView(shared.namespace, route);
        // At deploy time every candidate class is declared, and the upload keeps
        // those still holding objects (see `Version.keptMovers`). At runtime only
        // those the upload kept have a binding: declaring another would fail.
        for (const { binding, className } of legacy) {
          if (globalThis.__ALCHEMY_RUNTIME__ && shared.env?.[binding] === undefined) continue;
          if (!shared.movers.has(route)) shared.movers.set(route, binding);
          yield* declareAs(binding, className, source(shared, route, impl));
        }
        return routeView(shared.namespace, route);
      }),
    /** The model's class, unscoped: see `Resolver.namespace`. */
    namespace: shared.namespace,
    /** Every route this code hosts in the model's class. */
    routes: (): ReadonlyArray<string> => [...shared.routes.keys()],
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
      return Effect.as(
        Effect.logWarning(
          `domain object ${parsed.route}/${parsed.key} started on code without its route`,
        ),
        undefined,
      ).pipe(
        Effect.andThen(() =>
          Effect.succeed(
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
          ),
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
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          // Checked and claimed at once: an alarm and a call never both start a step.
          const start = yield* Effect.sync(() => {
            if (driving || owned() || now < staleUntil) return false;
            driving = true;
            return true;
          });
          if (!start) return;
          yield* Effect.gen(function* () {
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
            if (!owned()) {
              const now = yield* Clock.currentTimeMillis;
              yield* Effect.promise(() => raw.setAlarm(now));
            }
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                failures += 1;
                lastError = Cause.pretty(cause).slice(0, 2000);
                if (STALE.test(lastError)) {
                  // On older code: leave it idle long enough to move to the deployed code.
                  staleUntil = (yield* Clock.currentTimeMillis) + STALE_IDLE_MS;
                  yield* Effect.promise(() => raw.setAlarm(staleUntil + 100));
                  return;
                }
                yield* Effect.logWarning(`domain move ${name} failed (${failures})`, cause);
                const wait = Math.min(30_000, 250 * 2 ** Math.min(failures, 7));
                const now = yield* Clock.currentTimeMillis;
                yield* Effect.promise(() => raw.setAlarm(now + wait));
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
        const until = (yield* Clock.currentTimeMillis) + STALE_HOLD_MS;
        let now = yield* Clock.currentTimeMillis;
        while (!owned() && now < staleUntil && now < until) {
          yield* Effect.sleep("250 millis");
          now = yield* Clock.currentTimeMillis;
          if (now >= staleUntil) yield* step(0);
        }
      });

      /** Make sure something drives the move: a pending alarm, or a step under way. */
      const ensureDriven = Effect.gen(function* () {
        if (driving || owned()) return;
        if ((yield* Effect.promise(() => raw.getAlarm())) === null) {
          const now = yield* Clock.currentTimeMillis;
          yield* Effect.promise(() => raw.setAlarm(now));
        }
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
          // The migration's call: answer once the move is done or `waitMillis`
          // passes. The alarm does the copying, in an invocation of its own: run
          // here, its calls would nest under the migration's, and Cloudflare
          // limits how deep calls within a Worker go.
          case "domainMove":
            return (waitMillis: number) =>
              Effect.gen(function* () {
                const until = (yield* Clock.currentTimeMillis) + waitMillis;
                while (!owned() && (yield* Clock.currentTimeMillis) < until) {
                  yield* ensureDriven;
                  yield* Effect.sleep("100 millis");
                }
                return owned();
              });
          default: {
            if (LOCAL.has(prop)) return undefined;
            // Every call makes sure the move is driven (a stalled one restarts),
            // and waits while the old object is left to move to the deployed code.
            const before = Effect.andThen(ensureDriven, holdWhileStale);
            /** Serve here: the old object is sealed, so finish taking over first. */
            const serveHere = (use: (member: unknown) => Effect.Effect<unknown>) =>
              Effect.gen(function* () {
                yield* step(COPY_BUDGET_MS);
                if (!owned())
                  return yield* Effect.die(
                    new Error(`${name} is still taking over from its old object; try again`),
                  );
                return yield* use((instance as Record<string, unknown>)[prop]);
              });
            if (prop === "fetch")
              // A sealed old object forwards to this one: never forward back.
              return Effect.andThen(
                before,
                Move.moveState(raw)?.phase === "seal"
                  ? serveHere((member) => member as Effect.Effect<unknown>)
                  : (forwardTo(forwarded, prop) as Effect.Effect<unknown>),
              );
            // Until the move is done, the old object serves: it holds the data. A sealed
            // one refuses (it would forward back here, and each call would bounce until
            // Cloudflare's depth limit), and this object takes over and serves instead.
            return (...args: ReadonlyArray<unknown>) =>
              Effect.andThen(
                before,
                Effect.gen(function* () {
                  if (Move.moveState(raw)?.phase === "seal")
                    return yield* serveHere((member) =>
                      (member as (...a: ReadonlyArray<unknown>) => Effect.Effect<unknown>)(...args),
                    );
                  const answer = yield* from!.domainForward!(prop, args).pipe(
                    Effect.map((value): Forwarded => ({ value })),
                    Effect.catchCause((cause): Effect.Effect<Forwarded, unknown> => {
                      const text = Cause.pretty(cause);
                      if (text.includes(SEALED)) return Effect.succeed({ sealed: true } as const);
                      // Code from before the deploy has no `domainForward`, and never forwards back.
                      if (STALE.test(text)) return Effect.succeed({ stale: true } as const);
                      return Effect.failCause(cause);
                    }),
                  );
                  if ("value" in answer) return answer.value;
                  if ("stale" in answer) return yield* from![prop]!(...args);
                  return yield* serveHere((member) =>
                    (member as (...a: ReadonlyArray<unknown>) => Effect.Effect<unknown>)(...args),
                  );
                }),
              );
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
        // A sealed object that doesn't know its key has moved, and emptied its storage (the
        // key with it): it answers as moved, so the migration doesn't count it as stuck.
        domainName: () =>
          Effect.flatMap(key, (name) =>
            name === undefined && Move.isSealing(raw)
              ? Effect.die(new Error(`This Durable Object's ${MOVED}`))
              : Effect.succeed(name ?? null),
          ),
        domainMoveBegin: () => Move.beginSource(raw),
        domainMoveSnapshot: (after: Move.SnapshotCursor) => Move.snapshotPage(raw, after),
        domainMoveChanges: (after: number) => Move.changesPage(raw, after),
        domainMoveSeal: () => Move.seal(raw, () => state.raw.getWebSockets()),
        domainMoveSql: (at: Move.SqlCursor | null) => Move.sqlPage(raw, at),
        domainMoveFinish: () => Move.finish(raw),
        /** A call the new object forwards while it doesn't own the key: refused once sealed. */
        domainForward: (prop: string, args: ReadonlyArray<unknown>) => {
          if (Move.isSealing(raw)) return Effect.die(new Error(SEALED));
          const member = instance[prop];
          if (typeof member !== "function")
            return Effect.die(new Error(`${prop} is not a method of ${route}`));
          return Move.counted(
            raw,
            (member as (...a: ReadonlyArray<unknown>) => Effect.Effect<unknown>)(...args),
          );
        },
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

/**
 * One thing a migration run moves:
 *
 * - a listed object: its old class, its route in the model's class, and its hex id;
 * - an object by name: its route and its key (a directory node, a run's root);
 * - a directory entry: its source name, id and generation. A source's history
 *   names its consumer objects, which move with it.
 */
type MoveItem =
  | { readonly c: string; readonly b?: string; readonly r: string; readonly id: string }
  | { readonly r: string; readonly n: string }
  | { readonly s: string; readonly i: string; readonly g?: number };

/** A pass of a migration run. */
interface MovePass extends FanOut.Pass {
  readonly target: string;
}

/** What a migration run moves: the pages of ids the deploy listed, and the model's directory. */
export interface MovePlan {
  readonly pages: ReadonlyArray<{
    readonly n: number;
    /** The page's old class. Keys travel in Workflow params, which the API snake-cases: one word each. */
    readonly cls: string;
    readonly size: number;
  }>;
  /**
   * Walk the model's directory too: every object it lists, the consumer
   * objects their histories reached, and every run's root. Set when the
   * deployed code lists its objects, so nothing it wrote is missed.
   */
  readonly walk?: boolean;
}

/** The object of a consumer's run class that records its history: see `Domain/index.ts`. */
export const RUN_ROOT = "~run";

/** The paths a run lists beyond its pages: the directory's nodes, and the runs' roots. */
const DIRECTORY = "#dir:";
const RUNS = "#runs";

/** A page of ids the deploy listed, as the root keeps it (one-word keys: see `MovePlan`). */
interface StoredPage {
  readonly cls: string;
  /** The binding the code reaches the class by: `Billing.AccountAggregate.BeforeVersions` for one from before versions. */
  readonly bind?: string;
  readonly route: string;
  readonly ids: ReadonlyArray<string>;
}

const pageKey = (target: string, n: string | number) => `mg:page:${target}:${n}`;
const skipKey = (target: string) => `mg:skip:${target}`;
/** The object that keeps page `n` of a run: the root takes no calls from the relay tree. */
const pageObject = (target: string, n: number) => `page:${target}:${n}`;
/** The object that counts a run's skipped objects. */
const skipsObject = (target: string) => `skips:${target}`;

/** How long a pass of a migration run keeps at it before the root starts another. */
const MIGRATION_PASS_MS = 5 * 60_000;

/** The root and relay objects of a migration run. */
const migrationStub = (classes: Classes, key: string) =>
  makeRpcStub<Stub>(
    (
      classes.env?.[classes.className] as { getByName: (name: string) => unknown } | undefined
    )?.getByName(`${MIGRATION_ROUTE}/${key}`) ??
      classes.namespace.getByName(`${MIGRATION_ROUTE}/${key}`),
  );

const orDie = <A>(effect: Effect.Effect<unknown, unknown>) =>
  effect.pipe(Effect.orDie) as Effect.Effect<A>;

/** A listed object: its old class, route and hex id. */
type ListedItem = Extract<MoveItem, { readonly id: string }>;

/**
 * Move one listed object: find its key (its name), and ask its new object to
 * move its data, waiting up to `waitMillis` for the flip. `skipped` for an
 * object that knows neither its name nor its key.
 */
const moveListed = (classes: Classes, item: ListedItem, waitMillis: number) =>
  Effect.gen(function* () {
    const legacy = classes.env?.[item.b ?? item.c];
    const shared = classes.env?.[classes.className];
    if (legacy === undefined || shared === undefined) {
      yield* Effect.logWarning(
        `domain move skipped ${JSON.stringify(item)}: ${legacy === undefined ? "no binding for its class" : `no binding for ${classes.className}`}`,
      );
      return "skipped" as const;
    }
    const id = legacy.idFromString(item.id);
    const asked = yield* makeRpcStub<Stub>(legacy.get(id)).domainName!().pipe(
      Effect.map((name) => ({ name: name as string | null })),
      // Sealed by an earlier move: its data is in the new object already.
      Effect.catchCause((cause) =>
        Cause.pretty(cause).includes(MOVED)
          ? Effect.succeed({ moved: true } as const)
          : Effect.die(Cause.squash(cause)),
      ),
    );
    if ("moved" in asked) return "moved" as const;
    const name = asked.name;
    if (name === null) {
      yield* Effect.logWarning(`domain move skipped ${JSON.stringify(item)}: it knows no name`);
      return "skipped" as const;
    }
    const scoped = id.jurisdiction === undefined ? shared : shared.jurisdiction(id.jurisdiction);
    const target = makeRpcStub<Stub>(scoped.getByName(`${item.r}/${name}`));
    return (yield* orDie<boolean>(target.domainMove!(waitMillis)))
      ? ("moved" as const)
      : ("pending" as const);
  });

/** Ask `route/key`'s object to move its data: `true` once it owns it. */
const moveNamed = (resolver: Resolver, route: string, key: string, waitMillis: number) =>
  orDie<boolean>((resolver.namespace.getByName(`${route}/${key}`) as Stub).domainMove!(waitMillis));

/** Consumer keys a source answers per call, from its history. */
const CONSUMERS_PAGE = 500;

/** A source's consumer objects: a path the relays list from its history and split. */
const CONSUMERS = "#cons:";

/** A directory entry's object: `true` once it owns its data. */
const moveEntry = (
  resolver: Resolver,
  item: Extract<MoveItem, { readonly s: string }>,
  waitMillis: number,
) => {
  const entry = resolver.entry({
    source: item.s,
    id: item.i,
    ...(item.g === undefined ? {} : { generation: item.g }),
  });
  return entry === undefined
    ? Effect.succeed(true)
    : moveNamed(resolver, entry.route, item.i, waitMillis);
};

/**
 * A page of the objects a source's history reached: each consumer key, its
 * scanner in the consumer's run, and the stream keys a projection writes.
 * The source answers from its stored history whether or not it has moved.
 */
const listConsumers = (resolver: Resolver, ref: Backfill.SourceRef, after: string | undefined) =>
  Effect.gen(function* () {
    const entry = resolver.entry(ref);
    if (entry === undefined) return { entries: [] } satisfies FanOut.Listed<MoveItem>;
    const source = resolver.namespace.getByName(`${entry.route}/${ref.id}`) as Stub;
    const page = yield* orDie<{
      readonly consumers: ReadonlyArray<{
        readonly target: Delivery["target"];
        readonly key: string;
      }>;
      readonly next: number | null;
    }>(source.mgConsumers!(ref.id, after === undefined ? 0 : Number(after), CONSUMERS_PAGE));
    const objects = new Map<string, { readonly r: string; readonly n: string }>();
    const add = (r: string, n: string) => objects.set(`${r}/${n}`, { r, n });
    for (const { target, key } of page.consumers) {
      const routes = resolver.consumer(target);
      if (routes === undefined) continue;
      add(routes.keys, key);
      // A scanner of this source in the consumer's run (policies have no run).
      if (routes.run !== routes.keys) add(routes.run, resolver.scanner(ref));
      if (target.kind === "projection")
        for (const stream of resolver.streams(target.name)) add(stream, key);
    }
    return {
      entries: [...objects.values()].map((ref) => ({ ref })),
      ...(page.next === null ? {} : { next: String(page.next) }),
    } satisfies FanOut.Listed<MoveItem>;
  });

/**
 * What a path of a migration run lists: a directory node, a source's
 * consumers, the consumers' runs, or a page of listed ids. Relays list paths
 * themselves, never through the run's root: Cloudflare limits how deep calls
 * within a Worker go, and calls into the root from deep in the tree would
 * leave its own work deep too.
 */
const listPath = (classes: Classes, target: string, path: string, after: string | undefined) =>
  Effect.gen(function* () {
    // The model's directory: a node's own object, its child nodes and its entries.
    if (path.startsWith(`${target}${DIRECTORY}`)) {
      const resolver = classes.resolver;
      if (resolver === undefined) return { entries: [] } satisfies FanOut.Listed<MoveItem>;
      const node = path.slice(`${target}${DIRECTORY}`.length);
      const page = yield* orDie<Backfill.Listing>(
        (resolver.namespace.getByName(`${resolver.directory}/node:${node}`) as Stub).list!(
          node,
          after,
        ),
      );
      return {
        entries: [
          ...(after === undefined ? [{ ref: { r: resolver.directory, n: `node:${node}` } }] : []),
          ...page.children.map((child) => ({ path: `${target}${DIRECTORY}${child}` })),
          ...page.rows.flatMap((ref): ReadonlyArray<FanOut.Entry<MoveItem>> => {
            const item = {
              s: ref.source,
              i: ref.id,
              ...(ref.generation === undefined ? {} : { g: ref.generation }),
            };
            return resolver.entry(ref)?.source
              ? [{ ref: item }, { path: `${target}${CONSUMERS}${JSON.stringify(item)}` }]
              : [{ ref: item }];
          }),
        ],
        ...(page.next === undefined ? {} : { next: page.next }),
      } satisfies FanOut.Listed<MoveItem>;
    }
    // A source's consumer objects, from its history.
    if (path.startsWith(`${target}${CONSUMERS}`)) {
      const resolver = classes.resolver;
      if (resolver === undefined) return { entries: [] } satisfies FanOut.Listed<MoveItem>;
      const item = JSON.parse(path.slice(`${target}${CONSUMERS}`.length)) as {
        s: string;
        i: string;
        g?: number;
      };
      return yield* listConsumers(
        resolver,
        {
          source: item.s,
          id: item.i,
          ...(item.g === undefined ? {} : { generation: item.g }),
        },
        after,
      );
    }
    // Every consumer's run: its root records how far its history got.
    if (path === `${target}${RUNS}`) {
      const runs = classes.resolver?.runs() ?? [];
      return {
        entries: runs.map((run) => ({ ref: { r: run, n: RUN_ROOT } })),
      } satisfies FanOut.Listed<MoveItem>;
    }
    // A page of listed ids, kept in an object of its own.
    const n = Number(path.slice(path.lastIndexOf("#") + 1));
    const page = yield* orDie<StoredPage | undefined>(
      migrationStub(classes, pageObject(target, n)).mgPage!(target, n),
    );
    return {
      entries: (page?.ids ?? []).map((id) => ({
        ref: { c: page!.cls, ...(page!.bind ? { b: page!.bind } : {}), r: page!.route, id },
      })),
    } satisfies FanOut.Listed<MoveItem>;
  });

/** How a migration run's relays list a page and move an object: see `FanOut`. */
const migrationWork = (classes: Classes): FanOut.Work<MovePass, MoveItem> => ({
  label: "move",
  list: (pass, path, after) => listPath(classes, pass.target, path, after),
  handle: (pass, item, waitMillis) => {
    if ("id" in item)
      return Effect.flatMap(moveListed(classes, item, waitMillis), (outcome) =>
        outcome === "skipped"
          ? Effect.as(
              orDie(migrationStub(classes, skipsObject(pass.target)).mgSkip!(pass.target, item.c)),
              true,
            )
          : Effect.succeed(outcome === "moved"),
      );
    const resolver = classes.resolver;
    // Code that hasn't built the model can't find its objects: ask again later.
    if (resolver === undefined)
      return Effect.as(
        Effect.logWarning(`domain move: ${classes.className} isn't built here yet; asked again`),
        false,
      );
    return "n" in item
      ? moveNamed(resolver, item.r, item.n, waitMillis)
      : moveEntry(resolver, item, waitMillis);
  },
  describe: (item) =>
    "id" in item
      ? `${item.c}/${item.id}`
      : "n" in item
        ? `${item.r}/${item.n}`
        : `${item.s}/${item.i}`,
  relay: (name, pass, entries) =>
    orDie<FanOut.Result>(
      migrationStub(classes, `relay:${pass.target}:${name}`).mgRelay!(name, pass, entries),
    ),
});

/** A frontier entry's name in the root's marks of what is done. */
const entryKey = (entry: FanOut.Entry<MoveItem>) =>
  "path" in entry
    ? `p:${entry.path}`
    : "id" in entry.ref
      ? `i:${entry.ref.c}/${entry.ref.id}`
      : "n" in entry.ref
        ? `n:${entry.ref.r}/${entry.ref.n}`
        : `s:${entry.ref.s}/${entry.ref.i}${entry.ref.g === undefined ? "" : `#${entry.ref.g}`}`;

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
        yield* backfillRuntime(classes.random, (id) => run!.run(id));
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
            // The root lists the directory into its frontier, so its levels never nest relay
            // calls (Cloudflare limits how deep calls within a Worker go). Pages and a source's
            // consumers stay subtrees: the relays list and split them, a fan-out under each.
            expand: (path) =>
              !path.includes(CONSUMERS) && (path.includes(DIRECTORY) || path.endsWith(RUNS)),
            roots: (pass, state) => [
              ...state.plan.pages.map((page) => ({ path: `${pass.target}#${page.n}` })),
              ...(state.plan.walk
                ? [{ path: `${pass.target}${DIRECTORY}` }, { path: `${pass.target}${RUNS}` }]
                : []),
            ],
            samePlan: (a, b) =>
              a.walk === b.walk &&
              a.pages.map((page) => `${page.cls}#${page.n}`).join(",") ===
                b.pages.map((page) => `${page.cls}#${page.n}`).join(","),
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
            const skipped = yield* orDie<Record<string, number>>(
              migrationStub(classes, skipsObject(target)).mgSkipped!(target),
            );
            return { ...progress, skipped };
          }),
        /** What a path lists: see `listPath`. */
        mgList: (target: string, path: string, after?: string) =>
          listPath(classes, target, path, after),
        /** A page of listed ids, kept in its own object (`pageObject`). */
        mgPage: (target: string, n: number) => storage.get<StoredPage>(pageKey(target, n)),
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
        /** The skipped objects' counts by class, kept in their own object (`skipsObject`). */
        mgSkipped: (target: string) =>
          Effect.map(
            storage.get<Record<string, number>>(skipKey(target)),
            (skipped) => skipped ?? {},
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
      /** The model's class, which holds the run. */
      readonly cls: string;
      readonly target: string;
      readonly pages: ReadonlyArray<StoredPage & { readonly n: number }>;
    }
  /** Start the run, and wait until it is complete: each check's output is its progress. */
  | {
      readonly op: "run";
      readonly cls: string;
      readonly target: string;
      readonly plan: MovePlan;
      /** The pages, when they fit in the params: no `add` instance to wait for first. */
      readonly pages?: ReadonlyArray<StoredPage & { readonly n: number }>;
    }
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
    const object = (key: string) =>
      makeRpcStub<Stub>(env[params.cls].getByName(`${MIGRATION_ROUTE}/${key}`));
    const root = object(`run:${params.target}`);
    const call = <A>(what: string, effect: Effect.Effect<unknown, unknown>) =>
      effect.pipe(Effect.mapError(failed(what))) as Effect.Effect<A, DomainMoveFailed>;
    if (params.op === "add") {
      for (const { n, ...page } of params.pages)
        yield* task(
          `add-${n}`,
          call(
            "keeping a page",
            object(pageObject(params.target, n)).mgAdd!(params.target, n, page),
          ),
          {
            retries: { limit: 10, delay: "2 seconds", backoff: "exponential" },
          },
        );
      return {};
    }
    // Pages that came with the params: kept in parallel, in one step.
    if (params.pages !== undefined && params.pages.length > 0)
      yield* task(
        "add",
        call(
          "keeping the pages",
          Effect.forEach(
            params.pages,
            ({ n, ...page }) => object(pageObject(params.target, n)).mgAdd!(params.target, n, page),
            { concurrency: 6, discard: true },
          ),
        ),
        { retries: { limit: 10, delay: "2 seconds", backoff: "exponential" } },
      );
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
      // Each check is two steps (an instance has 10,000): once a second lasts over an hour.
      yield* sleep(`wait-${check}`, "1 second");
    }
  });
