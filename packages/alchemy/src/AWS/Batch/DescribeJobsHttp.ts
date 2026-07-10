import * as batch from "@distilled.cloud/aws/batch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import { DescribeJobs, type DescribeJobsRequest } from "./DescribeJobs.ts";
import type { JobQueue } from "./JobQueue.ts";

export const DescribeJobsHttp = Layer.effect(
  DescribeJobs,
  Effect.gen(function* () {
    const describeJobs = yield* batch.describeJobs;

    return Effect.fn(function* (queue: JobQueue) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.Batch.DescribeJobs(${queue}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["batch:DescribeJobs"],
                // batch:DescribeJobs does not support resource-level IAM.
                Resource: ["*"],
              },
            ],
          });
        }
      }

      return Effect.fn(`AWS.Batch.DescribeJobs(${queue.LogicalId})`)(function* (
        request: DescribeJobsRequest,
      ) {
        return yield* describeJobs(request);
      });
    });
  }),
);
