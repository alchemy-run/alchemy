/**
 * The runs a deploy begins. A version bump gives the model a consumer of a
 * new generation, whose run catches it up on the history. The pool's new
 * runners begin that run once they join, before anything calls the model:
 * a model that nothing calls still catches up.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { clusterPostgres, type DeployedStack, psql } from "./database.ts";

/** The deploy's new run never began. */
class RunNotBegun extends Data.TaggedError("RunNotBegun")<{
  readonly message: string;
}> {}

/** The objects that keep a consumer's run (`~run`), each one's rows in the storage table. */
const runObjects = (container: string) =>
  psql(
    container,
    "SELECT DISTINCT object FROM alchemy_domain_objects WHERE object LIKE '%/~run' ORDER BY 1",
  );

/**
 * Deploy, then wait for a run that wasn't there before to begin, with no
 * call to the model in between.
 */
export const beginsNewRun = <E, R>(
  stack: DeployedStack,
  deploy: Effect.Effect<void, E, R>,
): Effect.Effect<void, E | RunNotBegun | Effect.Error<ReturnType<typeof psql>>, R> =>
  Effect.gen(function* () {
    const container = yield* clusterPostgres(stack);
    const before = new Set(yield* runObjects(container));
    yield* deploy;
    yield* runObjects(container).pipe(
      Effect.flatMap((after) =>
        after.some((object) => !before.has(object))
          ? Effect.void
          : Effect.fail(
              new RunNotBegun({
                message: `no run began after the deploy; runs: ${after.join(", ") || "none"}`,
              }),
            ),
      ),
      Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 60 }),
    );
  });
