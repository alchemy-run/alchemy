import * as AWS from "alchemy-effect/AWS";
import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";

/**
 * Deploy-time binding for the ECS example’s jobs queue. Provide with
 * `Layer.succeed(ExampleJobsQueue, queue)` from the stack after the queue exists.
 */
export class JobsQueue extends ServiceMap.Service<JobsQueue, AWS.SQS.Queue>()(
  "JobsQueue",
) {}

export const JobsQueueLive = Layer.effect(
  JobsQueue,
  AWS.SQS.Queue("JobsQueue"),
);
