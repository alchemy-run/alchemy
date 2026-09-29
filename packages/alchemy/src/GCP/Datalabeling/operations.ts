import * as datalabeling from "@distilled.cloud/gcp/datalabeling_v1beta1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { noRetryLayer } from "./internal.ts";

export class DatalabelingOperationFailed extends Data.TaggedError(
  "GCP.Datalabeling.OperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class DatalabelingOperationPending extends Data.TaggedError(
  "GCP.Datalabeling.OperationPending",
)<{
  operation: string;
}> {}

const alreadyExists = (error: datalabeling.GoogleRpcStatus | undefined) =>
  error?.code === 6 ||
  (error?.message ?? "").toUpperCase().includes("ALREADY_EXISTS");

const isNotFoundStatus = (error: datalabeling.GoogleRpcStatus | undefined) =>
  error?.code === 5 ||
  (error?.message ?? "").toLowerCase().includes("not found");

const isIgnorable = (
  error: datalabeling.GoogleRpcStatus | undefined,
  options?: { notFoundOk?: boolean },
) =>
  alreadyExists(error) ||
  (options?.notFoundOk === true && isNotFoundStatus(error));

const stringField = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export const resourceNameFromOperation = (
  operation: datalabeling.GoogleLongrunningOperation,
): string | undefined => {
  const response = operation.response;
  const responseName = stringField(response?.name);
  if (responseName !== undefined) {
    return responseName;
  }
  const metadata = operation.metadata;
  const metadataName = stringField(metadata?.name);
  if (metadataName !== undefined) {
    return metadataName;
  }
  const target = stringField(metadata?.target);
  if (target !== undefined) {
    return target;
  }
  return undefined;
};

/**
 * Poll `getProjectsOperations` until `done`. Instruction and feedback
 * message create are long-running operations.
 */
export const waitForOperation = (
  operation: datalabeling.GoogleLongrunningOperation,
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
        return yield* new DatalabelingOperationFailed({
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
      return yield* new DatalabelingOperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const getOperation = datalabeling
      .getProjectsOperations({ name })
      .pipe(Effect.provide(noRetryLayer));
    const resolved =
      options?.notFoundOk === true
        ? getOperation.pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed<datalabeling.GoogleLongrunningOperation>({
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
        () => new DatalabelingOperationPending({ operation: name }),
      ),
      Effect.filterOrFail(
        (current) => !current.error || isIgnorable(current.error, options),
        (current) =>
          new DatalabelingOperationFailed({
            operation: name,
            message: current.error?.message ?? "operation failed",
          }),
      ),
      Effect.retry({
        while: (error) => error instanceof DatalabelingOperationPending,
        times: options?.times ?? 10,
        schedule: Schedule.spaced(options?.interval ?? "3 seconds"),
      }),
    );
  });
