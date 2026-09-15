import * as retail from "@distilled.cloud/gcp/retail_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Retail has no interruptible wait RPC. Poll get-operation with a hard
 * iteration cap.
 */
export class RetailOperationFailed extends Data.TaggedError(
  "GCP.Retail.OperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class RetailOperationPending extends Data.TaggedError(
  "GCP.Retail.OperationPending",
)<{
  operation: string;
}> {}

const alreadyExists = (error: retail.GoogleRpcStatus | undefined) =>
  error?.code === 6 ||
  (error?.message ?? "").toLowerCase().includes("already exists");

const isNotFoundStatus = (error: retail.GoogleRpcStatus | undefined) =>
  error?.code === 5 ||
  (error?.message ?? "").toLowerCase().includes("not found");

export const resourceNameFromOperation = (
  operation: retail.GoogleLongrunningOperation,
): string | undefined => {
  const response = operation.response;
  if (response && typeof response === "object" && "name" in response) {
    const name = (response as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) return name;
  }
  const metadata = operation.metadata;
  if (metadata && typeof metadata === "object") {
    const record = metadata as { target?: unknown; name?: unknown };
    if (typeof record.target === "string" && record.target.length > 0) {
      return record.target;
    }
    if (typeof record.name === "string" && record.name.length > 0) {
      return record.name;
    }
  }
  return undefined;
};

const getOperation = (name: string) =>
  name.includes("/catalogs/")
    ? retail.getProjectsLocationsCatalogsOperations({ name })
    : name.includes("/locations/")
      ? retail.getProjectsLocationsOperations({ name })
      : retail.getProjectsOperations({ name });

export const waitForOperation = (
  operation: retail.GoogleLongrunningOperation,
  options?: { notFoundOk?: boolean },
) =>
  Effect.gen(function* () {
    const name = operation.name;
    if (operation.done === true) {
      if (operation.error) {
        if (alreadyExists(operation.error)) return operation;
        if (options?.notFoundOk === true && isNotFoundStatus(operation.error)) {
          return operation;
        }
        return yield* new RetailOperationFailed({
          operation: name ?? "",
          message: operation.error.message ?? "operation failed",
        });
      }
      return operation;
    }
    if (name === undefined || name.length === 0) {
      if (options?.notFoundOk === true) return operation;
      return yield* new RetailOperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const resolved =
      options?.notFoundOk === true
        ? getOperation(name).pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed<retail.GoogleLongrunningOperation>({
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
        () => new RetailOperationPending({ operation: name }),
      ),
      Effect.flatMap((current) => {
        const error = current.error;
        if (!error) return Effect.succeed(current);
        if (alreadyExists(error)) return Effect.succeed(current);
        if (options?.notFoundOk === true && isNotFoundStatus(error)) {
          return Effect.succeed(current);
        }
        return Effect.fail(
          new RetailOperationFailed({
            operation: name,
            message: error.message ?? "operation failed",
          }),
        );
      }),
      Effect.retry({
        while: (error) => error._tag === "GCP.Retail.OperationPending",
        times: 10,
        schedule: Schedule.spaced("5 seconds"),
      }),
    );
  });
