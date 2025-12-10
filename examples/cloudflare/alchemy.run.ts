import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import {
  type StageConfig,
  defineStack,
  defineStages,
  USER,
} from "alchemy-effect";
import * as Cloudflare from "alchemy-effect/cloudflare";
import { Api } from "./src/api.ts";

const stages = defineStages(
  Effect.fn(function* (stage) {
    return {
      retain: stage.startsWith("prod"),
      cloudflare: {
        // TODO(sam): integrate with alchemy's profile system
        account: yield* Config.string("CLOUDFLARE_ACCOUNT_ID"),
      },
    } satisfies StageConfig;
  }),
);

export const MyService = stages.ref<typeof stack>("my-cloudflare-app").as({
  prod: "prod",
  staging: "staging",
  preview: (pr: number) => `preview_${pr.toString()}`,
  dev: (user: USER = USER) => `dev_${user}`,
});

const stack = defineStack({
  name: "my-cloudflare-app",
  stages,
  resources: [Api],
  providers: Cloudflare.providers(),
  tap: ({ Api }) => Effect.log(Api.url),
});

export default stack;
