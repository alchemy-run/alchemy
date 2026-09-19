import * as healthcare from "@distilled.cloud/gcp/healthcare_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

export class HealthcareOperationFailed extends Data.TaggedError(
  "GCP.Healthcare.OperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class HealthcareOperationPending extends Data.TaggedError(
  "GCP.Healthcare.OperationPending",
)<{
  operation: string;
}> {}

const alreadyExists = (error: healthcare.Status | undefined) =>
  error?.code === 6 ||
  (error?.message ?? "").toUpperCase().includes("ALREADY_EXISTS");

const isNotFoundStatus = (error: healthcare.Status | undefined) =>
  error?.code === 5 ||
  (error?.message ?? "").toLowerCase().includes("not found");

const isIgnorable = (
  error: healthcare.Status | undefined,
  options?: { notFoundOk?: boolean },
) =>
  alreadyExists(error) ||
  (options?.notFoundOk === true && isNotFoundStatus(error));

/**
 * Poll `getProjectsLocationsDatasetsOperations` until `done`. Dataset
 * create is a long-running operation; store CRUD is synchronous.
 */
export const waitForOperation = (
  operation: healthcare.Operation,
  options?: {
    notFoundOk?: boolean;
    interval?: `${number} seconds`;
    times?: number;
  },
) =>
  Effect.gen(function* () {
    const name = operation.name;
    if (operation.done === true) {
      if (operation.error && !isIgnorable(operation.error, options)) {
        return yield* new HealthcareOperationFailed({
          operation: name ?? "",
          message: operation.error.message ?? "operation failed",
        });
      }
      return operation;
    }
    if (name === undefined || name.length === 0) {
      if (options?.notFoundOk === true) {
        return operation;
      }
      return yield* new HealthcareOperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const getOperation = healthcare.getProjectsLocationsDatasetsOperations({
      name,
    });
    const resolved =
      options?.notFoundOk === true
        ? getOperation.pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed<healthcare.Operation>({
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
        () => new HealthcareOperationPending({ operation: name }),
      ),
      Effect.flatMap((current) => {
        const error = current.error;
        if (error && !isIgnorable(error, options)) {
          return Effect.fail(
            new HealthcareOperationFailed({
              operation: name,
              message: error.message ?? "operation failed",
            }),
          );
        }
        return Effect.succeed(current);
      }),
      Effect.retry({
        while: (error) => error._tag === "GCP.Healthcare.OperationPending",
        times: options?.times ?? 10,
        schedule: Schedule.spaced(options?.interval ?? "3 seconds"),
      }),
    );
  });
