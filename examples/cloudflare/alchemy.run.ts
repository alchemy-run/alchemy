import * as Effect from "effect/Effect";
import * as Config from "effect/Config";

import { type StageConfig, defineStack, defineStages } from "alchemy-effect";
import * as Cloudflare from "alchemy-effect/cloudflare";
import * as AWS from "alchemy-effect/aws";

import { Api } from "./src/api.ts";

const AWS_REGION = Config.string("AWS_REGION").pipe(Config.withDefault("us-west-2"));
const AWS_PROFILE = Config.string("AWS_PROFILE");
const AWS_ACCOUNT = Config.string("AWS_ACCOUNT");
const CLOUDFLARE_ACCOUNT_ID = Config.string("CLOUDFLARE_ACCOUNT_ID");

// alchemy deploy --stage preview_us-west-1_123
// alchemy deploy --stack my-cloudflare-app --stage preview_us-west-1_123
// alchemy deploy -s my-cloudflare-app --stage preview_us-west-1_123
// alchemy deploy # --stage dev_samgoodwin

const stages = defineStages(
  Effect.fn(function* (stage) {
    const [env, region = yield* AWS_REGION] = stage.split("_");
    return {
      retain: env === "prod",
      aws: {
        profile: yield* AWS_PROFILE,
        region,
        account:
          {
            prod: "123",
            staging: "456",
            preview: "789",
            dev: "101",
          }[env] ?? (yield* AWS_ACCOUNT),
      },
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
