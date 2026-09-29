import * as ccaip from "@distilled.cloud/gcp/contactcenteraiplatform_v1alpha1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

export class ContactcenteraiplatformOperationFailed extends Data.TaggedError(
  "GCP.Contactcenteraiplatform.OperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class ContactcenteraiplatformOperationPending extends Data.TaggedError(
  "GCP.Contactcenteraiplatform.OperationPending",
)<{
  operation: string;
}> {}

const alreadyExists = (error: ccaip.Status | undefined) =>
  error?.code === 6 ||
  (error?.message ?? "").toUpperCase().includes("ALREADY_EXISTS");

const isNotFoundStatus = (error: ccaip.Status | undefined) =>
  error?.code === 5 ||
  (error?.message ?? "").toLowerCase().includes("not found");

const isIgnorable = (
  error: ccaip.Status | undefined,
  options?: { notFoundOk?: boolean },
) =>
  alreadyExists(error) ||
  (options?.notFoundOk === true && isNotFoundStatus(error));

export const resourceNameFromOperation = (
  operation: ccaip.Operation,
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
  if (typeof metadataName === "string" && metadataName.length > 0) {
    return metadataName;
  }
  return undefined;
};

/**
 * Poll `getProjectsLocationsOperations` until `done`. Contact Center
 * create, update, and delete are long-running operations.
 */
export const waitForOperation = (
  operation: ccaip.Operation,
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
        return yield* new ContactcenteraiplatformOperationFailed({
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
      return yield* new ContactcenteraiplatformOperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const getOperation = ccaip.getProjectsLocationsOperations({ name });
    const resolved =
      options?.notFoundOk === true
        ? getOperation.pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed<ccaip.Operation>({
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
        () => new ContactcenteraiplatformOperationPending({ operation: name }),
      ),
      Effect.filterOrFail(
        (current) => !current.error || isIgnorable(current.error, options),
        (current) =>
          new ContactcenteraiplatformOperationFailed({
            operation: name,
            message: current.error?.message ?? "operation failed",
          }),
      ),
      Effect.retry({
        while: (error) =>
          error._tag === "GCP.Contactcenteraiplatform.OperationPending",
        times: options?.times ?? 10,
        schedule: Schedule.spaced(options?.interval ?? "8 seconds"),
      }),
    );
  });
