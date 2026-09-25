import * as logging from "@distilled.cloud/gcp/logging_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { GcpEnvironment } from "../Environment.ts";

export class LoggingOperationFailed extends Data.TaggedError(
  "GCP.Logging.OperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class LoggingOperationPending extends Data.TaggedError(
  "GCP.Logging.OperationPending",
)<{
  operation: string;
}> {}

const isNotFoundStatus = (error: logging.Status | undefined) =>
  error?.code === 5 ||
  (error?.message ?? "").toUpperCase().includes("NOT_FOUND");

const getOperation = (name: string) =>
  name.includes("/billingAccounts/") || name.startsWith("billingAccounts/")
    ? logging.getBillingAccountsLocationsOperations({ name })
    : name.includes("/folders/") || name.startsWith("folders/")
      ? logging.getFoldersLocationsOperations({ name })
      : name.includes("/organizations/") || name.startsWith("organizations/")
        ? logging.getOrganizationsLocationsOperations({ name })
        : name.includes("/projects/") || name.startsWith("projects/")
          ? logging.getProjectsLocationsOperations({ name })
          : logging.getLocationsOperations({ name });

export const waitForOperation = (
  operation: logging.Operation,
  options?: { notFoundOk?: boolean },
) =>
  Effect.gen(function* () {
    const name = operation.name;
    if (operation.done === true) {
      if (operation.error) {
        if (options?.notFoundOk === true && isNotFoundStatus(operation.error)) {
          return operation;
        }
        return yield* new LoggingOperationFailed({
          operation: name ?? "",
          message: operation.error.message ?? "operation failed",
        });
      }
      return operation;
    }
    if (name === undefined || name.length === 0) {
      return yield* new LoggingOperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const lookup = getOperation(name);
    const resolved =
      options?.notFoundOk === true
        ? lookup.pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed<logging.Operation>({
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
        () => new LoggingOperationPending({ operation: name }),
      ),
      Effect.flatMap((current) => {
        const error = current.error;
        if (
          error &&
          !(options?.notFoundOk === true && isNotFoundStatus(error))
        ) {
          return Effect.fail(
            new LoggingOperationFailed({
              operation: name,
              message: error.message ?? "operation failed",
            }),
          );
        }
        return Effect.succeed(current);
      }),
      Effect.retry({
        while: (error) => error._tag === "GCP.Logging.OperationPending",
        times: 10,
        schedule: Schedule.spaced("5 seconds"),
      }),
    );
  });

export const deleteBucketLinks = (bucketName: string) =>
  logging
    .listLocationsBucketsLinks({
      parent: bucketName,
      pageSize: 100,
    })
    .pipe(
      Effect.flatMap((page) =>
        Effect.forEach(
          page.links ?? [],
          (link) => {
            const name = link.name;
            if (name === undefined) return Effect.void;
            return logging.deleteLocationsBucketsLinks({ name }).pipe(
              Effect.catchTag(["NotFound", "Conflict"], () => Effect.void),
              Effect.asVoid,
            );
          },
          { concurrency: 4 },
        ),
      ),
      Effect.catchTag(["NotFound", "Forbidden"], () => Effect.void),
      Effect.asVoid,
    );

export const listProjectBuckets = () =>
  Effect.gen(function* () {
    const env = yield* GcpEnvironment.current;
    return yield* logging.listProjectsLocationsBuckets
      .pages({
        parent: `projects/${env.project}/locations/-`,
        pageSize: 1000,
      })
      .pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.buckets ?? [])),
        Stream.filter((bucket) => (bucket.name ?? "").length > 0),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      );
  });
