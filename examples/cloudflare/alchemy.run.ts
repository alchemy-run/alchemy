import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import { type StageConfig, defineStack, defineStages } from "alchemy-effect";
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

export const MyService = stages.ref<typeof stack>("my-cloudflare-app");

const stack = defineStack({
  name: "my-cloudflare-app",
  stages,
  resources: [Api],
  providers: Cloudflare.providers(),
}).pipe(Effect.tap(({ resources }) => Effect.log(resources.Api.url)));

export default stack;
