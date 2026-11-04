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
import {
  exportPage,
  importPage,
  OwnsAlarmCallbacks,
  TRANSFER_KEY_PREFIX,
  type TransferCursor,
  type TransferPage,
} from "../Workers/internal/DurableObjectTransfer.ts";
import { makeRpcStub } from "../Workers/Rpc.ts";
import type { WebSocket } from "../Workers/WebSocket.ts";
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
 * A Worker upgraded from version 0 keeps each old class live as a mover until
 * its objects have moved: the first call to a key's new object, a deploy's
 * {@link MIGRATION_WORKFLOW}, or the old object's own alarm moves its storage
 * over. See `Version.ts` for when the old classes are deleted.
 */
export const SHARED_CLASS = "AlchemyDomain";

/** The key an object listed itself under in the backfill directory. */
export const ID_KEY = "bf:id";

/** Set on a new object once it holds its old object's storage. */
const ADOPTED = `${TRANSFER_KEY_PREFIX}adopted`;
/** The next page of the old object's storage, while the move is under way. */
const CURSOR = `${TRANSFER_KEY_PREFIX}cursor`;

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
     * had in version 0: declared as a mover, so a Worker upgraded from it
     * moves their storage over.
     */
    object: (route: string, impl: ObjectImpl, legacy?: string) =>
      Effect.gen(function* () {
        shared.routes.set(route, impl);
        if (legacy !== undefined && !shared.movers.has(route)) {
          shared.movers.set(route, legacy);
          yield* declare(legacy, mover(shared, route));
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

/**
 * Copy the old object's storage into this one, then empty the old object.
 * Runs while the object is constructed, before any other event reaches it.
 */
const adopt = (storage: cf.DurableObjectStorage, from: Stub) =>
  Effect.gen(function* () {
    if (yield* Effect.promise(() => storage.get<boolean>(ADOPTED))) return;
    // Where an earlier attempt got to: a large object that doesn't move within
    // one construction (30 seconds) moves over several.
    let cursor = (yield* Effect.promise(() => storage.get<TransferCursor>(CURSOR))) ?? null;
    let alarm: number | null = null;
    do {
      const page = (yield* from.domainExport!(cursor).pipe(
        Effect.mapError(failed("reading the old object")),
      )) as TransferPage;
      yield* importPage(storage, page);
      cursor = page.next;
      if (cursor === null) alarm = page.alarm ?? null;
      else yield* Effect.promise(() => storage.put(CURSOR, cursor));
    } while (cursor !== null);
    yield* rearm(storage, alarm);
    yield* Effect.promise(() => storage.put(ADOPTED, true));
    yield* from.domainFinish!().pipe(Effect.mapError(failed("emptying the old object")));
  });

/**
 * Arm the alarm for the stored callbacks that came over, or for the old
 * object's own alarm if it had no callbacks.
 */
const rearm = (storage: cf.DurableObjectStorage, alarm: number | null) =>
  Effect.gen(function* () {
    const next = yield* Effect.sync(() => {
      const tables = new Set(
        storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('alchemy_alarm_callbacks', 'alchemy_scheduled_events')",
          )
          .toArray()
          .map((row) => row.name),
      );
      let next: number | null = null;
      for (const table of tables) {
        const at = storage.sql
          .exec<{ run_at: number | null }>(`SELECT MIN(run_at) AS run_at FROM ${table}`)
          .one().run_at;
        if (at !== null && (next === null || at < next)) next = at;
      }
      return next;
    });
    const at = next ?? alarm;
    const now = yield* Clock.currentTimeMillis;
    if (at !== null) yield* Effect.promise(() => storage.setAlarm(Math.max(at, now + 1)));
  });

/** The shared class: each object runs its route's implementation. */
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
      return Effect.succeed({ alarm: () => Effect.void, domainAdopt: () => Effect.void });
    const inner = yield* impl;
    const from = movers.has(parsed.route)
      ? legacyStub(classes(), parsed.route, parsed.key, state.id.jurisdiction)
      : undefined;
    return Effect.gen(function* () {
      if (from !== undefined) yield* adopt(state.raw.storage, from).pipe(Effect.orDie);
      const instance = yield* inner;
      return {
        ...instance,
        // The migration's call: the move ran when the object was constructed;
        // empty the old object again in case that didn't complete.
        domainAdopt: () =>
          from === undefined
            ? Effect.void
            : from.domainFinish!().pipe(Effect.mapError(failed("emptying the old object"))),
      };
    });
  });

/**
 * A version 0 class while its objects move: it serves nothing, and hands its
 * storage to the new object of the same key.
 */
const mover = (classes: Classes, route: string): ObjectImpl =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    return Effect.gen(function* () {
      const storage = state.raw.storage;
      const key = Effect.gen(function* () {
        // An object created before Durable Objects kept their names: the key it stored.
        return state.id.name ?? (yield* Effect.promise(() => storage.get<string>(ID_KEY))) ?? null;
      });
      const target = (name: string) => {
        const jurisdiction = state.id.jurisdiction as DurableObjectJurisdiction | undefined;
        const namespace =
          jurisdiction === undefined
            ? classes.namespace
            : classes.namespace.jurisdiction(jurisdiction);
        return namespace.getByName(`${route}/${name}`) as Stub;
      };
      /**
       * A call from a Worker isolate still on the code from before the upload
       * (for a few seconds while Cloudflare rolls it out): answered by the
       * key's new object, which moves this one's storage first.
       */
      const forward =
        (method: string) =>
        (...args: ReadonlyArray<unknown>) =>
          Effect.flatMap(key, (name) =>
            name === null
              ? Effect.die(new Error(`${route}: an object without a name can't be forwarded`))
              : target(name)[method]!(...args),
          );
      const known: Record<string | symbol, unknown> = {
        [OwnsAlarmCallbacks]: true,
        domainName: () => key,
        domainExport: (cursor: TransferCursor | null) => exportPage(storage, cursor),
        domainFinish: () =>
          Effect.promise(async () => {
            for (const socket of state.raw.getWebSockets()) {
              try {
                socket.close(1012, "moved");
              } catch {
                // already closed
              }
            }
            await storage.deleteAlarm();
            await storage.deleteAll();
          }),
        // A job was due here: move, and the new object runs it.
        alarm: () =>
          Effect.gen(function* () {
            const name = yield* key;
            if (name === null) return;
            yield* target(name).domainAdopt!().pipe(Effect.orDie);
          }),
        webSocketMessage: (socket: WebSocket) => socket.close(1012, "moved"),
        webSocketClose: () => Effect.void,
        webSocketError: () => Effect.void,
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest;
          const name = yield* key;
          if (name === null)
            return HttpServerResponse.text("This object moved and has no name", { status: 410 });
          return yield* (
            target(name) as unknown as {
              fetch: (
                request: HttpServerRequest,
              ) => Effect.Effect<HttpServerResponse.HttpServerResponse, unknown>;
            }
          )
            .fetch(request)
            .pipe(Effect.orDie);
        }),
      };
      // Every other method is forwarded: see `forward`.
      return new Proxy(known, {
        get: (target, prop) =>
          prop in target || typeof prop !== "string" || UNFORWARDED.has(prop)
            ? target[prop]
            : forward(prop),
        getOwnPropertyDescriptor: (target, prop) =>
          prop in target || typeof prop !== "string" || UNFORWARDED.has(prop)
            ? Reflect.getOwnPropertyDescriptor(target, prop)
            : { value: forward(prop), configurable: true, enumerable: false, writable: false },
      });
    });
  });

/** Members the runtime looks up on an instance that are not calls to forward. */
const UNFORWARDED = new Set(["then", "toJSON", "constructor", "pipe"]);

/** How many objects one step of the migration moves. */
const STEP = 25;

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
              yield* makeRpcStub<Stub>(scoped.getByName(`${params.route}/${name}`))
                .domainAdopt!().pipe(Effect.mapError(failed(`moving ${params.className} ${name}`)));
              return true;
            }),
          { concurrency: 8 },
        ),
        { retries: { limit: 5, delay: "2 seconds", backoff: "exponential" } },
      );
      for (const done of step) done ? moved++ : skipped++;
    }
    return { moved, skipped };
  });
