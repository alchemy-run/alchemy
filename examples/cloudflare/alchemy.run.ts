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

const CLOUDFLARE_ACCOUNT_ID = Config.string("CLOUDFLARE_ACCOUNT_ID");

const stages = defineStages(
  Effect.fn(function* (stage) {
    const [env] = stage.split("_");
    return {
      retain: env === "prod",
      cloudflare: {
        account:
          {
            prod: "123",
            staging: "456",
            preview: "789",
            dev: "101",
          }[env] ?? (yield* CLOUDFLARE_ACCOUNT_ID),
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
