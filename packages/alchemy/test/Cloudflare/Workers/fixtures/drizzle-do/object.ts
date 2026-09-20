import * as Cloudflare from "@/Cloudflare";
import * as Drizzle from "@/Drizzle/Cloudflare.ts";
import type { RuntimeContext } from "@/RuntimeContext.ts";
import * as Cause from "effect/Cause";
import { sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scheduler from "effect/Scheduler";
// The exact artifacts `drizzle-kit generate` emits for
// `driver: "durable-sqlite"` — a `migrations.js` that imports each
// migration's `.sql` file as a text module. Bare `.sql` imports resolve
// via the bundler's default text module types (see Bundle.ts), the same
// way Wrangler's `Text` rules handle them.
import migrations from "./drizzle/migrations.js";
import { posts, relations, users } from "./schema.ts";

class TransactionRejected extends Data.TaggedError("TransactionRejected")<{
  readonly message: string;
}> {}

class TransactionMarker extends Context.Service<TransactionMarker, string>()(
  "DrizzleTransactionMarker",
) {}

export class DrizzleClockObject extends Cloudflare.DurableObject<DrizzleClockObject>()(
  "DrizzleClockObject",
  Effect.succeed(Effect.succeed({ wait: () => Effect.sleep("100 millis") })),
) {}

export class DrizzleUsersObject extends Cloudflare.DurableObject<DrizzleUsersObject>()(
  "DrizzleUsersObject",
  Effect.gen(function* () {
    const clocks = yield* DrizzleClockObject;
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      // Opens drizzle over this instance's SQLite storage — with the
      // relational schema — and applies the generated migrations before
      // any request touches the db.
      const db = yield* Drizzle.DurableObject({ migrations, relations });

      return {
        clockName: () => Effect.sync(() => state.id.toString()),
        sqliteClock: () =>
          clocks.getByName(state.id.toString()).wait().pipe(Effect.as("ready")),
        sqliteGate: (view: boolean, publicApi = false) =>
          Effect.gen(function* () {
            const context = yield* Effect.context<RuntimeContext>();
            const clock = clocks.getByName(state.id.toString());
            // Native timers must be registered in the real enclosing input gate.
            return yield* Effect.promise(() =>
              state.raw.blockConcurrencyWhile(() => {
                let outerRan = false;
                let finished = false;
                let finishedBeforeClear: boolean | undefined;
                let release: Promise<void> | undefined;
                const outer = setTimeout(() => {
                  outerRan = true;
                }, 0);
                return Effect.runPromise(
                  Effect.gen(function* () {
                    const original = db.$client;
                    const client = view
                      ? original.withoutTransforms()
                      : original;
                    const callerScheduler = yield* Scheduler.Scheduler;
                    const withTransaction = publicApi
                      ? <A, E, R>(body: Effect.Effect<A, E, R>) =>
                          db.transaction(() => body)
                      : client.withTransaction;
                    const enteredAfterOuter = yield* withTransaction(
                      Effect.gen(function* () {
                        const enteredAfterOuter = outerRan;
                        // The independent DO completion can clear a blocked parent timer.
                        yield* Effect.sync(() => {
                          release = Effect.runPromise(
                            clock.wait().pipe(Effect.provideContext(context)),
                          ).then(() => {
                            finishedBeforeClear = finished;
                            clearTimeout(outer);
                          });
                        });
                        yield* client`SELECT 1`;
                        yield* Effect.yieldNow;
                        return enteredAfterOuter;
                      }),
                    );
                    const restoredScheduler = yield* Scheduler.Scheduler;
                    return {
                      enteredAfterOuter,
                      sameTransaction:
                        client.withTransaction === original.withTransaction,
                      samePermit: client.reserve === original.reserve,
                      sameTransactionContext:
                        client.transactionService ===
                        original.transactionService,
                      restoredScheduler: restoredScheduler === callerScheduler,
                    };
                  }).pipe(Effect.provideContext(context)),
                )
                  .then((value) => {
                    finished = true;
                    return release?.then(() => ({
                      ...value,
                      finishedBeforeClear,
                    }));
                  })
                  .finally(() => clearTimeout(outer));
              }),
            );
          }),
        sqliteRollback: () =>
          Effect.gen(function* () {
            const client = db.$client;
            const view = client.withoutTransforms();
            const finalized: string[] = [];
            const callerScope = yield* Effect.scope;
            const scopedBody = (value: string) =>
              Effect.gen(function* () {
                const marker = yield* TransactionMarker;
                const scope = yield* Effect.scope;
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    finalized.push(
                      `${marker}:${value}:${scope !== callerScope}`,
                    );
                  }),
                );
                yield* db.insert(users).values({ name: value });
              });
            const failed = yield* client
              .withTransaction(
                scopedBody("failed").pipe(
                  Effect.andThen(Effect.fail("rollback")),
                  Effect.scoped,
                ),
              )
              .pipe(Effect.exit);
            const defect = yield* client
              .withTransaction(
                scopedBody("defect").pipe(
                  Effect.andThen(Effect.die("rollback defect")),
                  Effect.scoped,
                ),
              )
              .pipe(Effect.exit);
            const started = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const writer = yield* Effect.forkChild(
              client.withTransaction(
                scopedBody("interrupted").pipe(
                  Effect.andThen(Deferred.succeed(started, undefined)),
                  Effect.andThen(Deferred.await(release)),
                  Effect.scoped,
                ),
              ),
            );
            yield* Deferred.await(started);
            const reader = yield* Effect.forkChild(
              view`SELECT name FROM users`,
              { startImmediately: true },
            );
            const waitingForPermit = yield* Effect.sync(
              () => reader.pollUnsafe() === undefined,
            );
            yield* Fiber.interrupt(writer);
            const interrupted = yield* Fiber.await(writer);
            const rowsAfterRollback = yield* Fiber.join(reader);
            yield* view.withTransaction(
              scopedBody("committed").pipe(Effect.scoped),
            );
            const finalRows = yield* view`SELECT name FROM users`;
            return {
              failed:
                Exit.isFailure(failed) &&
                failed.cause.reasons.some(
                  (reason) =>
                    Cause.isFailReason(reason) && reason.error === "rollback",
                ),
              defect:
                Exit.isFailure(defect) &&
                defect.cause.reasons.some(
                  (reason) =>
                    Cause.isDieReason(reason) &&
                    reason.defect === "rollback defect",
                ),
              interrupted:
                Exit.isFailure(interrupted) &&
                Cause.hasInterruptsOnly(interrupted.cause),
              waitingForPermit,
              rowsAfterRollback,
              finalRows,
              finalized,
              callerScopePreserved:
                (yield* Effect.scope) === callerScope &&
                callerScope.state._tag !== "Closed",
            };
          }).pipe(Effect.provideService(TransactionMarker, "caller")),
        drizzleInterrupt: (nested: boolean) =>
          Effect.gen(function* () {
            const entered = yield* Deferred.make<void>();
            const finalized: string[] = [];
            let continued = false;
            const callerScope = yield* Effect.scope;
            const writer = yield* Effect.forkChild(
              db.transaction(
                Effect.fn(function* (tx) {
                  yield* Effect.addFinalizer(() =>
                    Effect.sync(() => {
                      finalized.push("outer");
                    }),
                  );
                  yield* tx.insert(users).values({ name: "outer" });
                  const pause = Effect.gen(function* () {
                    yield* Deferred.succeed(entered, undefined);
                    yield* Effect.never;
                    continued = true;
                  });
                  if (nested) {
                    yield* tx.transaction(
                      Effect.fn(function* (inner) {
                        yield* Effect.addFinalizer(() =>
                          Effect.sync(() => {
                            finalized.push("inner");
                          }),
                        );
                        yield* inner.insert(users).values({ name: "inner" });
                        yield* pause;
                      }, Effect.scoped),
                    );
                  } else {
                    yield* pause;
                  }
                }, Effect.scoped),
              ),
            );
            yield* Deferred.await(entered);
            const reader = yield* Effect.forkChild(
              db.select({ name: users.name }).from(users),
              { startImmediately: true },
            );
            const waitingForPermit = yield* Effect.sync(
              () => reader.pollUnsafe() === undefined,
            );
            yield* Fiber.interrupt(writer);
            const result = yield* Fiber.await(writer);
            const rows = yield* Fiber.join(reader);
            yield* db.transaction(
              Effect.fn(function* (tx) {
                yield* tx.insert(users).values({ name: "committed" });
              }),
            );
            return {
              interrupted:
                Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause),
              rows,
              finalRows: yield* db.select({ name: users.name }).from(users),
              finalized,
              continued,
              waitingForPermit,
              callerScopePreserved:
                (yield* Effect.scope) === callerScope &&
                callerScope.state._tag !== "Closed",
            };
          }),
        drizzleTransaction: (scenario: string) =>
          Effect.gen(function* () {
            const rejected = new TransactionRejected({ message: "rollback" });
            const defect = new Error("transaction defect");
            const callerScope = yield* Effect.scope;
            const finalizers: string[] = [];
            let continued = false;
            let distinctTransaction = false;
            const result = yield* db
              .transaction(
                Effect.fn(function* (tx) {
                  distinctTransaction = !Object.is(tx, db);
                  const marker = yield* TransactionMarker;
                  yield* Effect.addFinalizer(() =>
                    Effect.sync(() => finalizers.push(marker)).pipe(
                      Effect.asVoid,
                    ),
                  );
                  yield* tx.insert(users).values({ name: "before" });
                  if (scenario.startsWith("async-")) {
                    yield* Effect.sleep("10 millis");
                    continued = true;
                  }
                  if (scenario === "failure" || scenario === "async-failure")
                    return yield* Effect.fail(rejected);
                  if (scenario === "defect" || scenario === "async-defect")
                    return yield* Effect.die(defect);
                  if (scenario === "rollback" || scenario === "async-rollback")
                    return yield* tx.rollback();
                  if (scenario.startsWith("nested")) {
                    yield* tx
                      .transaction(
                        Effect.fn(function* (inner) {
                          yield* inner.insert(users).values({ name: "inner" });
                          if (scenario.includes("async"))
                            yield* Effect.sleep("10 millis");
                          if (
                            scenario === "nested-failure" ||
                            scenario === "nested-async-failure"
                          )
                            return yield* Effect.fail(rejected);
                          if (scenario === "nested-async-rollback")
                            return yield* inner.rollback();
                        }),
                      )
                      .pipe(
                        Effect.catchTag(
                          [
                            "TransactionRejected",
                            "EffectTransactionRollbackError",
                          ],
                          () => Effect.void,
                        ),
                      );
                    if (
                      scenario === "nested-outer-failure" ||
                      scenario === "nested-async-outer-failure"
                    )
                      return yield* Effect.fail(rejected);
                  }
                  yield* tx.insert(users).values({ name: "after" });
                  return "committed";
                }, Effect.scoped),
              )
              .pipe(Effect.exit);
            // Observe writes from callbacks that incorrectly outlive a failed transaction.
            if (scenario.includes("async")) yield* Effect.sleep("50 millis");
            const rows = yield* db.select({ name: users.name }).from(users);
            return {
              success: Exit.isSuccess(result),
              value: Exit.isSuccess(result) ? result.value : undefined,
              typedFailure:
                Exit.isFailure(result) &&
                result.cause.reasons.some(
                  (reason) =>
                    Cause.isFailReason(reason) && reason.error === rejected,
                ),
              defect:
                Exit.isFailure(result) &&
                result.cause.reasons.some(
                  (reason) =>
                    Cause.isDieReason(reason) && reason.defect === defect,
                ),
              error: Exit.isFailure(result)
                ? Cause.pretty(result.cause)
                : undefined,
              rows,
              continued,
              finalizers,
              distinctTransaction,
              callerScopePreserved:
                (yield* Effect.scope) === callerScope &&
                callerScope.state._tag !== "Closed",
            };
          }).pipe(Effect.provideService(TransactionMarker, "caller")),
        addUser: (name: string) =>
          db
            .insert(users)
            .values({ name })
            .returning()
            .pipe(Effect.map((rows) => rows[0]!.id)),
        addPost: (userId: number, title: string) =>
          db.insert(posts).values({ userId, title }).pipe(Effect.asVoid),
        listUsers: () =>
          db
            .select()
            .from(users)
            .pipe(Effect.map((rows) => rows.map((row) => row.name))),
        // Relational query through the `relations` config — proves the
        // schema/relationships flow through Drizzle.DurableObject's types.
        listUsersWithPosts: () =>
          db.query.users.findMany({ with: { posts: true } }).pipe(
            Effect.map((rows) =>
              rows.map((row) => ({
                name: row.name,
                posts: row.posts.map((post) => post.title),
              })),
            ),
          ),
        // A deliberately failing query, recovered with a typed catch —
        // proves per-operation errors are tagged and catchable.
        queryMissingTable: () =>
          Effect.gen(function* () {
            return yield* db.run(sql`SELECT * FROM missing_table`).pipe(
              Effect.as("unexpected success"),
              Effect.catchTag("EffectDrizzleQueryError", (error) =>
                Effect.succeed(`caught:${error._tag}`),
              ),
            );
          }),
      };
    });
  }),
) {}
