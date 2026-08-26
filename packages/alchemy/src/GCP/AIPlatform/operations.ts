import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Vertex AI has no interruptible `wait` RPC. Poll
 * `getProjectsLocationsOperations` with a hard iteration cap.
 */
export class AiPlatformOperationFailed extends Data.TaggedError(
  "GCP.AIPlatform.OperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class AiPlatformOperationPending extends Data.TaggedError(
  "GCP.AIPlatform.OperationPending",
)<{
  operation: string;
}> {}

const isAlreadyExists = (error: aiplatform.GoogleRpcStatus | undefined) =>
  error?.code === 6 ||
  (error?.message ?? "").toUpperCase().includes("ALREADY_EXISTS");

const isNotFoundStatus = (error: aiplatform.GoogleRpcStatus | undefined) =>
  error?.code === 5 ||
  (error?.message ?? "").toLowerCase().includes("not found");

const isIgnorable = (
  error: aiplatform.GoogleRpcStatus | undefined,
  options?: { notFoundOk?: boolean },
) =>
  isAlreadyExists(error) ||
  (options?.notFoundOk === true && isNotFoundStatus(error));

export const resourceNameFromOperation = (
  operation: aiplatform.GoogleLongrunningOperation,
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
  return undefined;
};

export const waitForOperation = (
  operation: aiplatform.GoogleLongrunningOperation,
  options?: { notFoundOk?: boolean; alreadyExistsOk?: boolean },
) =>
  Effect.gen(function* () {
    const name = operation.name;
    if (operation.done === true) {
      if (operation.error && !isIgnorable(operation.error, options)) {
        return yield* new AiPlatformOperationFailed({
          operation: name ?? "",
          message: operation.error.message ?? "operation failed",
        });
      }
      return operation;
    }
    if (name === undefined || name.length === 0) {
      return yield* new AiPlatformOperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const getOperation = aiplatform.getProjectsLocationsOperations({ name });
    const resolved =
      options?.notFoundOk === true
        ? getOperation.pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed<aiplatform.GoogleLongrunningOperation>({
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
        () => new AiPlatformOperationPending({ operation: name }),
      ),
      Effect.flatMap((current) => {
        const error = current.error;
        if (error && !isIgnorable(error, options)) {
          return Effect.fail(
            new AiPlatformOperationFailed({
              operation: name,
              message: error.message ?? "operation failed",
            }),
          );
        }
        return Effect.succeed(current);
      }),
      Effect.retry({
        while: (error) => error._tag === "GCP.AIPlatform.OperationPending",
        times: 10,
        schedule: Schedule.spaced("5 seconds"),
      }),
    );
  });
