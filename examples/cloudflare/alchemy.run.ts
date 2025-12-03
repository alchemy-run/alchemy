import { defineStack, Stages, assertDefined } from "alchemy-effect";
import * as Cloudflare from "alchemy-effect/cloudflare/live";
import * as Effect from "effect/Effect";
import { Api } from "./src/api.ts";

const createConfig = (account?: string) => ({
  cloudflare: {
    account: assertDefined(account, "CLOUDFLARE_ACCOUNT_ID is not set"),
  },
});

const config = Stages.config({
  prod: createConfig(import.meta.env.CLOUDFLARE_ACCOUNT_ID_PROD),
  staging: createConfig(import.meta.env.CLOUDFLARE_ACCOUNT_ID!),
  dev: createConfig(import.meta.env.CLOUDFLARE_ACCOUNT_ID!),
});

const stackName = "my-cloudflare-app";

export type App = typeof stack;

export const App = Stages.of<App>(stackName, config);

const stack = defineStack(stackName, {
  resources: [Api],
  providers: Cloudflare.live(config().cloudflare),
}).pipe(Effect.tap(({ resources }) => Effect.log(resources.Api.url)));

export default stack;
