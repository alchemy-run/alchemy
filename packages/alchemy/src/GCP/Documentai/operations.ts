import * as documentai from "@distilled.cloud/gcp/documentai_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

export class DocumentaiOperationFailed extends Data.TaggedError(
  "GCP.Documentai.OperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class DocumentaiOperationPending extends Data.TaggedError(
  "GCP.Documentai.OperationPending",
)<{
  operation: string;
}> {}

const alreadyExists = (error: documentai.GoogleRpcStatus | undefined) =>
  error?.code === 6 ||
  (error?.message ?? "").toLowerCase().includes("already exists");

const isNotFoundStatus = (error: documentai.GoogleRpcStatus | undefined) =>
  error?.code === 5 ||
  (error?.message ?? "").toLowerCase().includes("not found");

const isIgnorable = (
  error: documentai.GoogleRpcStatus | undefined,
  options?: { notFoundOk?: boolean },
) =>
  alreadyExists(error) ||
  (options?.notFoundOk === true && isNotFoundStatus(error));

/**
 * Poll `getProjectsLocationsOperations` until `done`. Processor create is
 * synchronous; enable, disable, delete, and schema deletes are LROs.
 */
export const waitForOperation = (
  operation: documentai.GoogleLongrunningOperation,
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
        return yield* new DocumentaiOperationFailed({
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
      return yield* new DocumentaiOperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const getOperation = documentai.getProjectsLocationsOperations({
      name,
    });
    const resolved =
      options?.notFoundOk === true
        ? getOperation.pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed<documentai.GoogleLongrunningOperation>({
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
        () => new DocumentaiOperationPending({ operation: name }),
      ),
      Effect.flatMap((current) => {
        const error = current.error;
        if (error && !isIgnorable(error, options)) {
          return Effect.fail(
            new DocumentaiOperationFailed({
              operation: name,
              message: error.message ?? "operation failed",
            }),
          );
        }
        return Effect.succeed(current);
      }),
      Effect.retry({
        while: (error) => error._tag === "GCP.Documentai.OperationPending",
        times: options?.times ?? 10,
        schedule: Schedule.spaced(options?.interval ?? "3 seconds"),
      }),
    );
  });
