import { FetchHttpClient } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import * as Alchemy from "alchemy-effect";
import * as AWS from "alchemy-effect/aws";
import { Layer } from "effect";
import * as Effect from "effect/Effect";
import { Api, Consumer } from "./src/index.ts";

const app = Alchemy.app({ name: "my-app", stage: "dev" });

const providers = Layer.provideMerge(
  Layer.mergeAll(AWS.live, Alchemy.State.localFs, Alchemy.CLI.layer),
  Layer.mergeAll(app, Alchemy.dotAlchemy),
);

const layers = Layer.provideMerge(
  providers,
  Layer.mergeAll(NodeContext.layer, FetchHttpClient.layer),
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
