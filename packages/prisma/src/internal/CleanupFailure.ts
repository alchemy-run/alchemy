import * as Data from "effect/Data";

/**
 * A reconcile failed and the follow-up cleanup of the resource it created
 * also failed. `errors` holds the reconcile failure, then the cleanup failure.
 */
export class PrismaCleanupFailed extends Data.TaggedError("PrismaCleanupFailed")<{
  readonly message: string;
  readonly errors: readonly [originalError: unknown, cleanupError: unknown];
  readonly cause?: unknown;
}> {}

/**
 * Preserve both the reconcile failure and a subsequent cleanup failure.
 *
 * Cleanup failures are operationally important: suppressing one can leave an
 * untracked cloud resource behind with no indication of how to remove it.
 */
export const aggregateCleanupFailure = (
  resource: "App" | "deployment",
  resourceId: string,
  route: string,
  originalError: unknown,
  cleanupError: unknown,
) =>
  new PrismaCleanupFailed({
    message: `Failed to clean up Prisma ${resource} '${resourceId}' after reconcile failed. The resource may be orphaned. Manual cleanup: DELETE ${route}.`,
    errors: [originalError, cleanupError],
    cause: originalError,
  });
