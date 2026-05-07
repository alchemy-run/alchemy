import { API } from "@distilled.cloud/neon/Client";
import {
  CreateProjectBranchOutput,
  getProjectOperation,
  listProjectBranches,
  type ListProjectBranchesOutput,
  listProjects,
  type ListProjectsOutput,
} from "@distilled.cloud/neon/Operations";
import * as T from "@distilled.cloud/neon/Traits";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

/**
 * Local extension of the SDK's createProjectBranch operation. The
 * generated input schema only declares the `project_id` path parameter
 * and omits the `branch` / `endpoints` body fields, so we redefine the
 * input here while reusing the SDK's output schema.
 */
const CreateProjectBranchInput = Schema.Struct({
  project_id: Schema.String.pipe(T.PathParam()),
  branch: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      parent_id: Schema.optional(Schema.String),
      parent_lsn: Schema.optional(Schema.String),
      parent_timestamp: Schema.optional(Schema.String),
      init_source: Schema.optional(
        Schema.Literals(["schema-only", "parent-data"]),
      ),
      protected: Schema.optional(Schema.Boolean),
      expires_at: Schema.optional(Schema.String),
    }),
  ),
  endpoints: Schema.optional(
    Schema.Array(
      Schema.Struct({
        type: Schema.Literals(["read_only", "read_write"]),
        autoscaling_limit_min_cu: Schema.optional(Schema.Number),
        autoscaling_limit_max_cu: Schema.optional(Schema.Number),
        suspend_timeout_seconds: Schema.optional(Schema.Number),
      }),
    ),
  ),
}).pipe(T.Http({ method: "POST", path: "/projects/{project_id}/branches" }));

export const createProjectBranch = API.make(() => ({
  inputSchema: CreateProjectBranchInput,
  outputSchema: CreateProjectBranchOutput,
}));

export type NeonOperationStatus =
  | "scheduling"
  | "running"
  | "finished"
  | "failed"
  | "error"
  | "cancelling"
  | "cancelled"
  | "skipped";

export interface NeonOperationLike {
  readonly id: string;
  readonly project_id: string;
  readonly action: string;
  readonly status: NeonOperationStatus;
  readonly error?: string;
}

export class OperationFailed extends Data.TaggedError("OperationFailed")<{
  operationId: string;
  action: string;
  status: NeonOperationStatus;
  error?: string;
}> {}

class OperationPending extends Data.TaggedError("OperationPending")<{
  operationId: string;
}> {}

const isOperationComplete = (status: NeonOperationStatus): boolean =>
  status === "finished" ||
  status === "failed" ||
  status === "error" ||
  status === "cancelled" ||
  status === "skipped";

/**
 * Wait for the given operations to reach a terminal state. Polls every
 * 500ms with exponential backoff up to ~30s per operation.
 */
export const waitForOperations = (
  operations: ReadonlyArray<NeonOperationLike>,
) =>
  Effect.gen(function* () {
    for (const op of operations) {
      if (isOperationComplete(op.status)) {
        if (op.status === "failed" || op.status === "error") {
          return yield* new OperationFailed({
            operationId: op.id,
            action: op.action,
            status: op.status,
            error: op.error,
          });
        }
        continue;
      }
      yield* getProjectOperation({
        project_id: op.project_id,
        operation_id: op.id,
      }).pipe(
        Effect.flatMap(
          ({ operation }): Effect.Effect<void, OperationFailed | OperationPending> => {
            const status = operation.status as NeonOperationStatus;
            if (status === "failed" || status === "error") {
              return Effect.fail(
                new OperationFailed({
                  operationId: operation.id,
                  action: operation.action,
                  status,
                  error: operation.error,
                }),
              );
            }
            if (!isOperationComplete(status)) {
              return Effect.fail(new OperationPending({ operationId: op.id }));
            }
            return Effect.void;
          },
        ),
        Effect.retry({
          while: (e: unknown) => {
            const tag = (e as { _tag?: string })._tag;
            return (
              tag === "OperationPending" ||
              tag === "TooManyRequests" ||
              tag === "ServiceUnavailable" ||
              tag === "InternalServerError" ||
              tag === "BadGateway" ||
              tag === "GatewayTimeout"
            );
          },
          schedule: Schedule.both(
            Schedule.exponential(Duration.millis(500), 1.5),
            Schedule.recurs(60),
          ),
        }),
        Effect.catchTag("OperationPending", () => Effect.void),
      );
    }
  });

export type NeonProjectSummary = ListProjectsOutput["projects"][number];
export type NeonBranchSummary = ListProjectBranchesOutput["branches"][number];

/**
 * Find all projects whose `name` exactly matches the given name.
 * Pages through Neon's project search API.
 */
export const findProjectByName = (name: string) =>
  Effect.gen(function* () {
    const matches: NeonProjectSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = yield* listProjects({
        search: name,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      for (const p of page.projects) {
        if (p.name === name) matches.push(p);
      }
      cursor = page.pagination?.cursor;
    } while (cursor);
    return matches;
  });

/**
 * Find all branches of a project whose `name` exactly matches the given name.
 */
export const findBranchByName = (projectId: string, name: string) =>
  Effect.gen(function* () {
    const matches: NeonBranchSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = yield* listProjectBranches({
        project_id: projectId,
        search: name,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      for (const b of page.branches) {
        if (b.name === name) matches.push(b);
      }
      cursor = page.pagination?.next;
    } while (cursor);
    return matches;
  });
