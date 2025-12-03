import { defineStack, Stage, env } from "alchemy-effect";
import * as Cloudflare from "alchemy-effect/cloudflare/live";
import * as Effect from "effect/Effect";
import { Api } from "./src/api.ts";

const stackName = "my-cloudflare-app";

const stages = Stage.config<"prod" | "staging" | `dev-${string}`>(([stageRoot]) => ({
  cloudflare: {
    account: env[`CLOUDFLARE_ACCOUNT_ID${stageRoot.toUpperCase()}`],
  },
}));

export const App = stages.of<App>(stackName);

export type App = typeof stack;

const stack = defineStack(stackName, {
  stages,
  resources: [Api],
  providers: Cloudflare.providers(stages.current),
}).pipe(Effect.tap(({ resources }) => Effect.log(resources.Api.url)));

export default stack;
