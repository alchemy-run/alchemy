import { AWS } from "alchemy-effect";
import * as Http from "alchemy-effect/Http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { JobNotificationsSNS } from "./JobNotifications.ts";
import { JobRpcHttpEffect } from "./JobRpcApi.ts";
import { JobStorageDynamoDB } from "./JobStorage.ts";

const JobFunction = Effect.gen(function* () {
  // register a HTTP server in the Lambda Function runtime
  yield* Http.serve(yield* JobRpcHttpEffect);

  // return the Function properties for this stage
  return {
    main: import.meta.path,
    url: true,
  } as const satisfies AWS.Lambda.FunctionProps;
}).pipe(
  Effect.provide(
    Layer.mergeAll(
      // Services go here
      JobStorageDynamoDB,
      JobNotificationsSNS,
      AWS.Lambda.HttpServer,
    ),
  ),
  AWS.Lambda.Function("JobFunction"),
);

export default JobFunction;
