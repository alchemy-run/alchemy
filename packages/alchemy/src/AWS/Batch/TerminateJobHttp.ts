import * as batch from "@distilled.cloud/aws/batch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { JobQueue } from "./JobQueue.ts";
import { TerminateJob, type TerminateJobRequest } from "./TerminateJob.ts";

export const TerminateJobHttp = Layer.effect(
  TerminateJob,
  Effect.gen(function* () {
    const terminateJob = yield* batch.terminateJob;

    return Effect.fn(function* (queue: JobQueue) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.Batch.TerminateJob(${queue}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["batch:TerminateJob"],
                // Job ARNs (arn:...:job/{jobId}) are only known at runtime,
                // so the statement cannot enumerate them at deploy time.
                Resource: ["*"],
              },
            ],
          });
        }
      }

      return Effect.fn(`AWS.Batch.TerminateJob(${queue.LogicalId})`)(function* (
        request: TerminateJobRequest,
      ) {
        return yield* terminateJob(request);
      });
    });
  }),
);
