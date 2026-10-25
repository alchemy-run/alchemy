import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { JobService } from "./JobService.ts";
import { JobServiceDynamo } from "./JobServiceDynamo.ts";
import { JobServiceKV } from "./JobServiceKV.ts";

export const ApiKV = Cloudflare.Worker(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const jobs = yield* JobService;
    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text(JSON.stringify(yield* jobs.getJob("job-1")));
      }),
    };
  }).pipe(Effect.provide(JobServiceKV)),
);

export const ApiDynamo = Cloudflare.Worker(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const jobs = yield* JobService;
    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text(JSON.stringify(yield* jobs.getJob("job-1")));
      }),
    };
  }).pipe(Effect.provide(JobServiceDynamo)),
);
