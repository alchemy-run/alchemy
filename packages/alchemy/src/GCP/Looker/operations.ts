import * as looker from "@distilled.cloud/gcp/looker_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Looker has no `wait*` long-poll. Poll `getProjectsLocationsOperations`
 * with a hard iteration cap so creates cannot pin the HTTP pool.
 */
export class LookerOperationFailed extends Data.TaggedError(
  "GCP.Looker.OperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class LookerOperationPending extends Data.TaggedError(
  "GCP.Looker.OperationPending",
)<{
  operation: string;
}> {}

const alreadyExists = (error: looker.Status | undefined) =>
  error?.code === 6 ||
  (error?.message ?? "").toUpperCase().includes("ALREADY_EXISTS");

const isNotFoundStatus = (error: looker.Status | undefined) =>
  error?.code === 5 ||
  (error?.message ?? "").toLowerCase().includes("not found");

const isIgnorable = (
  error: looker.Status | undefined,
  options?: { notFoundOk?: boolean },
) =>
  alreadyExists(error) ||
  (options?.notFoundOk === true && isNotFoundStatus(error));

export const resourceNameFromOperation = (
  operation: looker.Operation,
): string | undefined => {
  const response = operation.response;
  const responseName = response?.name;
  if (typeof responseName === "string" && responseName.length > 0) {
    return responseName;
  }
  const metadata = operation.metadata;
  const target = metadata?.target;
  if (typeof target === "string" && target.length > 0) {
    return target;
  }
  const metadataName = metadata?.name;
  if (
    typeof metadataName === "string" &&
    metadataName.length > 0 &&
    metadataName.includes("/backups/")
  ) {
    return metadataName;
  }
  return undefined;
};

export const waitForOperation = (
  operation: looker.Operation,
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
        return yield* new LookerOperationFailed({
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
      return yield* new LookerOperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const getOperation = looker.getProjectsLocationsOperations({ name });
    const resolved =
      options?.notFoundOk === true
        ? getOperation.pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed<looker.Operation>({
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
        () => new LookerOperationPending({ operation: name }),
      ),
      Effect.flatMap((current) => {
        const error = current.error;
        if (error && !isIgnorable(error, options)) {
          return Effect.fail(
            new LookerOperationFailed({
              operation: name,
              message: error.message ?? "operation failed",
            }),
          );
        }
        return Effect.succeed(current);
      }),
      Effect.retry({
        while: (error) => error._tag === "GCP.Looker.OperationPending",
        times: options?.times ?? 10,
        schedule: Schedule.spaced(options?.interval ?? "8 seconds"),
      }),
    );
  });
