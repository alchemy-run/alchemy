import * as appengine from "@distilled.cloud/gcp/appengine_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

export class AppengineOperationFailed extends Data.TaggedError(
  "GCP.Appengine.OperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class AppengineOperationPending extends Data.TaggedError(
  "GCP.Appengine.OperationPending",
)<{
  operation: string;
}> {}

const isNotFoundStatus = (error: appengine.Status | undefined) =>
  error?.code === 5 ||
  (error?.message ?? "").toUpperCase().includes("NOT_FOUND");

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const parseOperationName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const appsAt = parts.indexOf("apps");
  const operationsAt = parts.lastIndexOf("operations");
  return {
    appsId: appsAt >= 0 ? parts[appsAt + 1] : undefined,
    operationsId:
      operationsAt >= 0 ? parts[operationsAt + 1] : lastSegment(name),
  };
};

const getOperation = (name: string, fallbackAppsId: string) => {
  const parsed = parseOperationName(name);
  const appsId = parsed.appsId ?? fallbackAppsId;
  const operationsId = parsed.operationsId ?? lastSegment(name);
  return appengine.getAppsOperations({ appsId, operationsId });
};

export const waitForOperation = (
  operation: appengine.Operation,
  options: { appsId: string; notFoundOk?: boolean },
) =>
  Effect.gen(function* () {
    const name = operation.name;
    if (operation.done === true) {
      if (operation.error) {
        if (options.notFoundOk === true && isNotFoundStatus(operation.error)) {
          return operation;
        }
        return yield* new AppengineOperationFailed({
          operation: name ?? "",
          message: operation.error.message ?? "operation failed",
        });
      }
      return operation;
    }
    if (name === undefined || name.length === 0) {
      return yield* new AppengineOperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const lookup = getOperation(name, options.appsId);
    const resolved =
      options.notFoundOk === true
        ? lookup.pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed<appengine.Operation>({
                name,
                done: true,
              }),
            ),
          )
        : lookup.pipe(
            Effect.retry({
              while: (error) => error._tag === "NotFound",
              times: 5,
              schedule: Schedule.exponential("250 millis"),
            }),
          );

    return yield* resolved.pipe(
      Effect.filterOrFail(
        (current) => current.done === true,
        () => new AppengineOperationPending({ operation: name }),
      ),
      Effect.flatMap((current) => {
        const error = current.error;
        if (
          error &&
          !(options.notFoundOk === true && isNotFoundStatus(error))
        ) {
          return Effect.fail(
            new AppengineOperationFailed({
              operation: name,
              message: error.message ?? "operation failed",
            }),
          );
        }
        return Effect.succeed(current);
      }),
      Effect.retry({
        while: (error) => error._tag === "GCP.Appengine.OperationPending",
        times: 10,
        schedule: Schedule.spaced("5 seconds"),
      }),
    );
  });
