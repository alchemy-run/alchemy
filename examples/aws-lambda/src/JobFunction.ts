import { AWS } from "alchemy-effect";
import * as Http from "alchemy-effect/Http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { JobHttpEffect } from "./JobHttpApi.ts";
import { JobNotificationsSNS } from "./JobNotifications.ts";
import { JobStorageDynamoDB } from "./JobStorage.ts";

// ## sync drift
// alchemy sync
// alchemy sync ./alchemy.run.ts
// alchemy sync ./alchemy.run.ts --no-adopt (default)
// alchemy sync ./alchemy.run.ts --stack

// ## adopt resources
// alchemy sync
// alchemy sync --adopt (all)
// alchemy sync ./alchemy.run.ts --adopt (all)
// alchemy sync ./alchemy.run.ts --adopt JobsQueue,JobsDatabase

// ## deploy
// alchemy deploy
// alchemy deploy --adopt
// alchemy deploy --dry-run --adopt
// alchemy deploy --dry-run --adopt JobsQueue,JobsDatabase

const JobFunction = Effect.gen(function* () {
  // register a HTTP server in the Lambda Function runtime
  yield* Http.serve(yield* JobHttpEffect);
  // if you want to use RPC instead of HttpApi:
  // yield* Http.serve(yield* JobRpcHttpEffect);

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
      // JobStorageS3,
      AWS.Lambda.HttpServer,
    ),
  ),
  AWS.Lambda.Function("JobFunction"),
);

export default JobFunction;
