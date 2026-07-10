import * as glue from "@distilled.cloud/aws/glue";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Job } from "./Job.ts";
import { StartJobRun, type StartJobRunRequest } from "./StartJobRun.ts";

export const StartJobRunHttp = Layer.effect(
  StartJobRun,
  Effect.gen(function* () {
    const startJobRun = yield* glue.startJobRun;

    return Effect.fn(function* (job: Job) {
      const JobName = yield* job.jobName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Glue.StartJobRun(${job}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["glue:StartJobRun", "glue:GetJobRun"],
                Resource: [job.jobArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.Glue.StartJobRun(${job.LogicalId})`)(function* (
        request: StartJobRunRequest = {},
      ) {
        return yield* startJobRun({ ...request, JobName: yield* JobName });
      });
    });
  }),
);
