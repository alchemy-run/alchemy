import * as ml from "@distilled.cloud/gcp/ml_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

export class MlOperationFailed extends Data.TaggedError(
  "GCP.Ml.OperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class MlOperationPending extends Data.TaggedError(
  "GCP.Ml.OperationPending",
)<{
  operation: string;
}> {}

const alreadyExists = (error: ml.GoogleRpc__Status | undefined) =>
  error?.code === 6 ||
  (error?.message ?? "").toUpperCase().includes("ALREADY_EXISTS");

const isNotFoundStatus = (error: ml.GoogleRpc__Status | undefined) =>
  error?.code === 5 ||
  (error?.message ?? "").toLowerCase().includes("not found");

const isIgnorable = (
  error: ml.GoogleRpc__Status | undefined,
  options?: { notFoundOk?: boolean },
) =>
  alreadyExists(error) ||
  (options?.notFoundOk === true && isNotFoundStatus(error));

const getOperation = (name: string) =>
  name.includes("/locations/")
    ? ml.getProjectsLocationsOperations({ name })
    : ml.getProjectsOperations({ name });

/**
 * Poll `projects.operations.get` (or the locations variant) until `done`.
 * Version create/delete and model delete/patch are long-running.
 */
export const waitForOperation = (
  operation: ml.GoogleLongrunning__Operation,
  options?: {
    notFoundOk?: boolean;
    times?: number;
    interval?: `${number} seconds`;
  },
) =>
  Effect.gen(function* () {
    const name = operation.name;
    if (operation.done === true) {
      if (operation.error && !isIgnorable(operation.error, options)) {
        return yield* new MlOperationFailed({
          operation: name ?? "",
          message: operation.error.message ?? "operation failed",
        });
      }
      return operation;
    }
    if (name === undefined || name.length === 0) {
      if (options?.notFoundOk === true) return operation;
      return yield* new MlOperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const resolved =
      options?.notFoundOk === true
        ? getOperation(name).pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed<ml.GoogleLongrunning__Operation>({
                name,
                done: true,
              }),
            ),
          )
        : getOperation(name).pipe(
            Effect.retry({
              while: (error) => error._tag === "NotFound",
              times: 5,
              schedule: Schedule.exponential("250 millis"),
            }),
          );

    return yield* resolved.pipe(
      Effect.filterOrFail(
        (current) => current.done === true,
        () => new MlOperationPending({ operation: name }),
      ),
      Effect.flatMap((current) => {
        const error = current.error;
        if (error && !isIgnorable(error, options)) {
          return Effect.fail(
            new MlOperationFailed({
              operation: name,
              message: error.message ?? "operation failed",
            }),
          );
        }
        return Effect.succeed(current);
      }),
      Effect.retry({
        while: (error) => error._tag === "GCP.Ml.OperationPending",
        times: options?.times ?? 10,
        schedule: Schedule.spaced(options?.interval ?? "3 seconds"),
      }),
    );
  });
