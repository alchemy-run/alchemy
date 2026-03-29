import { AWS } from "alchemy-effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { JobApiLive } from "./JobApi.ts";
import { JobNotificationsSNS } from "./JobNotifications.ts";
import { JobStorageDynamoDB } from "./JobStorage.ts";

export default class JobFunction extends AWS.Lambda.Function<JobFunction>()(
  "JobFunction",
  {
    main: import.meta.path,
    url: true,
  },
  HttpRouter.toHttpEffect(JobApiLive).pipe(
    Effect.provide(Layer.mergeAll(JobStorageDynamoDB, JobNotificationsSNS)),
  ),
) {}
