import { AWS } from "alchemy-effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { JobNotificationsSNS } from "./JobNotifications.ts";
import { JobRpcHttpEffect } from "./JobRpcApi.ts";
import { JobStorageDynamoDB } from "./JobStorage.ts";

export class JobFunction extends AWS.Lambda.Function<JobFunction>()(
  "JobFunction",
  {
    main: import.meta.path,
    url: true,
  },
) {}

export const JobFunctionLive = JobFunction.make(
  JobRpcHttpEffect.pipe(
    Effect.provide(Layer.mergeAll(JobStorageDynamoDB, JobNotificationsSNS)),
  ),
);

export default JobFunctionLive;
