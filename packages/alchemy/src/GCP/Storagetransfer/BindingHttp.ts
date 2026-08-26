import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { TransferJob } from "./TransferJob.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";

/**
 * Shared HTTP scaffolding for Storage Transfer job bindings.
 * NOT exported from index.ts.
 *
 * Distilled ops are `OperationMethod`s: yield them once at Layer construction
 * (after providing Credentials + HttpClient) so the inner runtime Effect is
 * `Effect<A, E>` and does not leak `GcpOpContext`.
 */
export const makeTransferJobHttpBinding = <
  I extends { jobName?: string },
  A,
  E,
>(options: {
  tag: string;
  role?: string;
  operation: Effect.Effect<
    (input: I) => Effect.Effect<A, E>,
    never,
    Credentials | HttpClient.HttpClient
  > &
    ((input: I) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>);
  projectInBody?: boolean;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (job: TransferJob) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: job,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const name = yield* job.name;
      const project = yield* job.project;
      return Effect.fn(`${options.tag}(${job.LogicalId})`)(function* (
        request?: Omit<I, "jobName">,
      ) {
        const jobName = yield* name;
        const projectId = yield* project;
        const input = {
          ...(request ?? {}),
          jobName,
        } as I;
        if (options.projectInBody) {
          const withBody = input as I & {
            body?: { projectId?: string };
          };
          withBody.body = {
            ...(withBody.body ?? {}),
            projectId: withBody.body?.projectId ?? projectId,
          };
        }
        return yield* run(input);
      });
    });
  });
