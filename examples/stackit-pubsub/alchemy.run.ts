import * as Stackit from "@alchemy.run/stackit";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import { Jobs, JobsSubscription, Results } from "./src/resources.ts";
import Worker from "./src/Worker.ts";

export default Alchemy.Stack(
  "StackitPubSubExample",
  { providers: Stackit.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const jobs = yield* Jobs;
    const subscription = yield* JobsSubscription;
    const results = yield* Results;
    const api = yield* Api;
    const worker = yield* Worker;

    return {
      url: api.url,
      projectId: api.projectId,
      region: api.region,
      environmentId: api.environmentId,
      apiId: api.applicationId,
      workerId: worker.applicationId,
      topicId: jobs.topicId,
      subscriptionId: subscription.subscriptionId,
      bucketName: results.bucketName,
    };
  }),
);
