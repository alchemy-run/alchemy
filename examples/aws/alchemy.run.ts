import { FetchHttpClient } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import * as Alchemy from "alchemy-effect";
import * as AWS from "alchemy-effect/aws";
import * as CLI from "alchemy-effect/cli";
import { Layer, Logger } from "effect";
import * as Effect from "effect/Effect";
import { Api, Consumer } from "./src/index.ts";

// select your underlying platform
const platform = Layer.mergeAll(
  NodeContext.layer,
  FetchHttpClient.layer,
  Logger.pretty,
);

// select your providers
const providers = Layer.mergeAll(AWS.live);

// override alchemy state store, CLI/reporting and dotAlchemy
const alchemy = Layer.mergeAll(
  Alchemy.State.localFs,
  CLI.layer,
  // optional
  Alchemy.dotAlchemy,
);

// define your app
const app = Alchemy.app({ name: "my-app", stage: "dev" });

const layers = Layer.provideMerge(
  Layer.provideMerge(providers, alchemy),
  Layer.mergeAll(platform, app),
);

await Alchemy.apply({
  phase: process.argv.includes("--destroy") ? "destroy" : "update",
  resources: [Api, Consumer],
}).pipe(
  Effect.provide(layers),
  Effect.tap((stack) =>
    Effect.log({
      url: stack?.Consumer.functionUrl,
      queueUrl: stack?.Messages.queueUrl,
    }),
  ),
  Effect.runPromiseExit,
);
