import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWS from "../aws/index.ts";
import * as Alchemy from "../index.ts";

import { ApiLambda } from "./api.ts";
import { Consumer } from "./messages.ts";

const app = Alchemy.app({ name: "my-iae-app", stage: "dev" });

const aws = AWS.defaultProviders.pipe(
  Layer.provide(AWS.Region.fromEnv),
  Layer.provide(AWS.Credentials.fromChain),
);

const plan = Alchemy.planAll(ApiLambda, Consumer);

const applied = Alchemy.apply(plan);

const infrastructure = await applied.pipe(
  Effect.provide(aws),
  Effect.provide(app),
  Effect.runPromise,
);

console.log({
  url: infrastructure.api.functionUrl,
});
