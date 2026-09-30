import * as compute from "@distilled.cloud/gcp/compute_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * GCP `wait*Operations` is a long-poll that can sit on a single HTTP
 * request for ~2 minutes and is not reliably interruptible. Concurrent
 * compute tests then pin the connection pool and the rest of the suite
 * starves. Poll `get*Operations` instead, with a hard iteration cap.
 */
export class ComputeOperationPending extends Data.TaggedError(
  "GCP.Compute.OperationPending",
)<{
  operation: string;
  status: string | undefined;
}> {}

const poll = <E extends { readonly _tag: string }, R>(
  name: string,
  get: Effect.Effect<compute.Operation, E, R>,
  times: number,
) =>
  get.pipe(
    Effect.filterOrFail(
      (operation) => operation.status === "DONE",
      (operation) =>
        new ComputeOperationPending({
          operation: name,
          status: operation.status,
        }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.OperationPending" ||
        error._tag === "NotFound",
      schedule: Schedule.spaced("2 seconds"),
      times,
    }),
  );

export const waitGlobalOperations = (
  input: { project: string; operation: string },
  options?: { times?: number },
) =>
  poll(
    input.operation,
    compute.getGlobalOperations({
      project: input.project,
      operation: input.operation,
    }),
    options?.times ?? 24,
  );

export const waitZoneOperations = (
  input: { project: string; zone: string; operation: string },
  options?: { times?: number },
) =>
  poll(
    input.operation,
    compute.getZoneOperations({
      project: input.project,
      zone: input.zone,
      operation: input.operation,
    }),
    options?.times ?? 24,
  );

export const waitRegionOperations = (
  input: { project: string; region: string; operation: string },
  options?: { times?: number },
) =>
  poll(
    input.operation,
    compute.getRegionOperations({
      project: input.project,
      region: input.region,
      operation: input.operation,
    }),
    options?.times ?? 24,
  );

/** Hierarchical firewall policies (and other org-scoped compute APIs). */
export const waitGlobalOrganizationOperations = (
  input: { operation: string; parentId?: string },
  options?: { times?: number },
) =>
  poll(
    input.operation,
    compute.getGlobalOrganizationOperations({
      operation: input.operation,
      parentId: input.parentId,
    }),
    options?.times ?? 24,
  );
