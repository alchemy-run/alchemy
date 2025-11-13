import { FetchHttpClient } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import * as Alchemy from "alchemy-effect";
import * as CLI from "alchemy-effect/cli";
import * as Cloudflare from "alchemy-effect/cloudflare/live";
import { Logger } from "effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Api } from "./src/api.ts";

// select your underlying platform
const platform = Layer.mergeAll(
  NodeContext.layer,
  FetchHttpClient.layer,
  Logger.pretty,
);

// select your providers
const providers = Layer.mergeAll(
  Cloudflare.live(),
  // AWS.live()
);

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

const stack = await Alchemy.apply({
  phase: process.argv.includes("--destroy") ? "destroy" : "update",
  resources: [Api],
}).pipe(
  Effect.provide(layers),
  Effect.tap((stack) => Effect.log(stack?.Api.url)),
  Effect.runPromise,
);

if (stack) {
  console.log(stack.Api.url);
}
