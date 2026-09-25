import * as translate from "@distilled.cloud/gcp/translate_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

export class TranslateOperationFailed extends Data.TaggedError(
  "GCP.Translate.OperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class TranslateOperationPending extends Data.TaggedError(
  "GCP.Translate.OperationPending",
)<{
  operation: string;
}> {}

const alreadyExists = (error: translate.Status | undefined) =>
  error?.code === 6 ||
  (error?.message ?? "").toLowerCase().includes("already exists");

const isNotFoundStatus = (error: translate.Status | undefined) =>
  error?.code === 5 ||
  (error?.message ?? "").toLowerCase().includes("not found");

const isIgnorable = (
  error: translate.Status | undefined,
  options?: { notFoundOk?: boolean },
) =>
  alreadyExists(error) ||
  (options?.notFoundOk === true && isNotFoundStatus(error));

/**
 * Poll `getProjectsLocationsOperations` until `done`. Model create/delete
 * and glossary create/delete are LROs. Adaptive MT datasets and glossary
 * entries are synchronous.
 */
export const waitForOperation = (
  operation: translate.Operation,
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
        return yield* new TranslateOperationFailed({
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
      return yield* new TranslateOperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const getOperation = translate.getProjectsLocationsOperations({
      name,
    });
    const resolved =
      options?.notFoundOk === true
        ? getOperation.pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed<translate.Operation>({
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
        () => new TranslateOperationPending({ operation: name }),
      ),
      Effect.flatMap((current) => {
        const error = current.error;
        if (error && !isIgnorable(error, options)) {
          return Effect.fail(
            new TranslateOperationFailed({
              operation: name,
              message: error.message ?? "operation failed",
            }),
          );
        }
        return Effect.succeed(current);
      }),
      Effect.retry({
        while: (error) => error._tag === "GCP.Translate.OperationPending",
        times: options?.times ?? 10,
        schedule: Schedule.spaced(options?.interval ?? "3 seconds"),
      }),
    );
  });
