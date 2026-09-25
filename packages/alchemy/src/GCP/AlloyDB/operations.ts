import * as alloydb from "@distilled.cloud/gcp/alloydb_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * AlloyDB has no `wait*` long-poll. Poll `getProjectsLocationsOperations`
 * with a hard iteration cap so creates cannot pin the HTTP pool.
 */
export class AlloyDbOperationFailed extends Data.TaggedError(
  "GCP.AlloyDB.OperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class AlloyDbOperationPending extends Data.TaggedError(
  "GCP.AlloyDB.OperationPending",
)<{
  operation: string;
}> {}

export const waitForOperation = (
  operation: alloydb.Operation,
  options?: { notFoundOk?: boolean },
) =>
  Effect.gen(function* () {
    const name = operation.name;
    if (operation.done === true) {
      if (operation.error) {
        return yield* new AlloyDbOperationFailed({
          operation: name ?? "",
          message: operation.error.message ?? "operation failed",
        });
      }
      return operation;
    }
    if (name === undefined || name.length === 0) {
      return yield* new AlloyDbOperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const getOperation = alloydb.getProjectsLocationsOperations({ name });
    const resolved =
      options?.notFoundOk === true
        ? getOperation.pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed<alloydb.Operation>({
                name,
                done: true,
              }),
            ),
          )
        : getOperation.pipe(
            Effect.retry({
              while: (error) => error._tag === "NotFound",
              times: 5,
              schedule: Schedule.exponential("250 millis"),
            }),
          );

    return yield* resolved.pipe(
      Effect.filterOrFail(
        (current) => current.done === true,
        () => new AlloyDbOperationPending({ operation: name }),
      ),
      Effect.flatMap((current) => {
        const error = current.error;
        return error
          ? Effect.fail(
              new AlloyDbOperationFailed({
                operation: name,
                message: error.message ?? "operation failed",
              }),
            )
          : Effect.succeed(current);
      }),
      Effect.retry({
        while: (error) => error._tag === "GCP.AlloyDB.OperationPending",
        times: 10,
        schedule: Schedule.spaced("8 seconds"),
      }),
    );
  });
