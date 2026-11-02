import * as Stackit from "@alchemy.run/stackit";
import * as Effect from "effect/Effect";

/** The queue. The API publishes one message per job. */
export const Jobs = Stackit.PubSub.Topic("Jobs", {});

/** Holds each message until the worker acknowledges it. */
export const JobsSubscription = Jobs.pipe(
  Effect.flatMap((topic) =>
    Stackit.PubSub.Subscription("JobsSubscription", {
      topicId: topic.topicId,
      ackDeadline: "60s",
    }),
  ),
);

/** One object per finished job, at `jobs/{id}.json`. A destroy deletes what is left in it. */
export const Results = Stackit.ObjectStorage.Bucket("Results", { forceDestroy: true });

/** What the API publishes and the worker consumes. */
export interface JobMessage {
  id: string;
  payload: string;
}

/** What the worker writes. */
export interface JobResult {
  id: string;
  status: "done";
  words: number;
  chars: number;
}

/** The bucket key of a job's result. */
export const resultKey = (id: string) => `jobs/${id}.json`;
