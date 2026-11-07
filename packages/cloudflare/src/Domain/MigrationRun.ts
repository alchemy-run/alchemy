import type * as Backfill from "@alchemy.run/domain/Backfill";
import * as FanOut from "@alchemy.run/domain/FanOut";
import type { Delivery } from "@alchemy.run/domain/Platform";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";
import { makeRpcStub } from "../Workers/Rpc.ts";
import { WorkerEnvironment } from "../Workers/WorkerRuntime.ts";
import { sleep, task } from "../Workflows/Workflow.ts";
import {
  type Classes,
  DomainMoveFailed,
  MOVED,
  type ObjectImpl,
  type Resolver,
  type Stub,
  failed,
  orDie,
} from "./ModelClass.ts";
import { backfillRuntime } from "./Runtime.ts";

/**
 * The migration run: a fan-out over Durable Objects (see `FanOut`) that moves
 * every object of a model's old classes into its class, and the Workflow a
 * deploy reaches it through.
 */

/**
 * The migration run's route in the shared class. Its root (`run:<target>`)
 * holds the objects to move, page by page, and drives a `FanOut` run over
 * them; its relays (`relay:<target>:<name>`) each move a share.
 */
export const MIGRATION_ROUTE = "~migration";

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
          : Effect.die(cause.pipe(Cause.squash)),
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
export const migrationObject = (classes: Classes): ObjectImpl =>
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
export const migration = (params: MigrationParams) =>
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
