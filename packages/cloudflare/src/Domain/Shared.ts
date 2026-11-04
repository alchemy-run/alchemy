import type * as cf from "@cloudflare/workers-types";
import type { RuntimeContext } from "alchemy/RuntimeContext";
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
import { task, Workflow, type WorkflowImpl } from "../Workflows/Workflow.ts";
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
        if (legacy !== undefined && !shared.movers.has(route)) {
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
    // A route the code no longer hosts keeps its data, and does nothing.
    if (parsed === undefined || impl === undefined)
      return Effect.succeed({ alarm: () => Effect.void, domainMove: () => Effect.succeed(true) });
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
      if (owned()) return { ...instance, domainMove: () => Effect.succeed(true) };
      const calls = sourceCalls(from!);

      /** Copy for a while; once caught up, take over with this object's own calls held. */
      const step = Effect.gen(function* () {
        yield* Move.begin(raw, calls);
        const ready = yield* Move.copyFor(raw, calls, COPY_BUDGET_MS);
        if (ready)
          yield* state.blockConcurrencyWhile(() => Move.takeOver(raw, calls).pipe(Effect.orDie));
        // Not done: carry on in the next alarm.
        else yield* Effect.promise(() => raw.setAlarm(Date.now()));
      });

      // Start the move as soon as the object is first used: its alarm drives it.
      if (
        Move.moveState(raw) === undefined &&
        (yield* Effect.promise(() => raw.getAlarm())) === null
      )
        yield* Effect.promise(() => raw.setAlarm(Date.now()));

      const forwarded = Effect.succeed(from);
      return dynamic((prop) => {
        if (owned()) {
          if (prop === "domainMove") return () => Effect.succeed(true);
          return (instance as Record<string, unknown>)[prop];
        }
        switch (prop) {
          case Move.OwnsAlarmCallbacks:
            return true;
          case "alarm":
            return () => step.pipe(Effect.orDie);
          // The migration's call: start the move, and answer once it's done or `waitMillis` passes.
          case "domainMove":
            return (waitMillis: number) =>
              Effect.gen(function* () {
                if ((yield* Effect.promise(() => raw.getAlarm())) === null)
                  yield* Effect.promise(() => raw.setAlarm(Date.now()));
                const until = (yield* Clock.currentTimeMillis) + waitMillis;
                while (!owned() && (yield* Clock.currentTimeMillis) < until)
                  yield* Effect.sleep("250 millis");
                return owned();
              });
          default:
            // Until the move is done, the old object serves: it holds the data.
            return LOCAL.has(prop) ? undefined : forwardTo(forwarded, prop);
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
    if (raw === undefined) return yield* impl;
    // A move already under way keeps logging after a restart.
    Move.resumeSource(raw);
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

/** How many objects one step of the migration moves, and how long each may take. */
const STEP = 25;
const MOVE_WAIT_MS = 10_000;

/**
 * Move each listed object of one old class (by hex id) to its key's object in
 * the shared class. The deploy lists the ids and waits for the instances.
 */
const migration = (params: {
  readonly className: string;
  readonly route: string;
  readonly ids: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const env = (yield* WorkerEnvironment) as Record<string, any>;
    const legacy = env[params.className];
    const shared = env[SHARED_CLASS];
    if (legacy === undefined || shared === undefined)
      return { moved: 0, skipped: params.ids.length };
    let moved = 0;
    let skipped = 0;
    for (let i = 0; i < params.ids.length; i += STEP) {
      const step = yield* task(
        `move-${i}`,
        Effect.forEach(
          params.ids.slice(i, i + STEP),
          (hex) =>
            Effect.gen(function* () {
              const id = legacy.idFromString(hex);
              const old = makeRpcStub<Stub>(legacy.get(id));
              const name = (yield* old.domainName!().pipe(
                Effect.mapError(failed(`reading ${params.className} ${hex}`)),
              )) as string | null;
              if (name === null) return false;
              const scoped =
                id.jurisdiction === undefined ? shared : shared.jurisdiction(id.jurisdiction);
              const target = makeRpcStub<Stub>(scoped.getByName(`${params.route}/${name}`));
              // Keep asking until it has moved: each call waits a while for the move.
              for (let tries = 0; ; tries++) {
                const done = (yield* target.domainMove!(MOVE_WAIT_MS).pipe(
                  Effect.mapError(failed(`moving ${params.className} ${name}`)),
                )) as boolean;
                if (done) return true;
                if (tries >= 20)
                  return yield* new DomainMoveFailed({
                    message: `moving ${params.className} ${name}: still copying after ${tries} waits`,
                  });
              }
            }),
          { concurrency: 6 },
        ),
        { retries: { limit: 5, delay: "2 seconds", backoff: "exponential" } },
      );
      for (const done of step) done ? moved++ : skipped++;
    }
    return { moved, skipped };
  });
