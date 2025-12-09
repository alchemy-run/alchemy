import { defineStack, defineStages } from "alchemy-effect";
import { Api } from "./src/api.ts";
import { Consumer } from "./src/consumer.ts";
import * as AWS from "alchemy-effect/aws";
import * as Cloudflare from "alchemy-effect/cloudflare";
import * as Layer from "effect/Layer";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

const AWS_REGION = Config.string("AWS_REGION").pipe(Config.withDefault("us-west-2"));
const AWS_PROFILE = Config.string("AWS_PROFILE");
const AWS_ACCOUNT = Config.string("AWS_ACCOUNT");
const CLOUDFLARE_ACCOUNT_ID = Config.string("CLOUDFLARE_ACCOUNT_ID");

const stages = defineStages(
  Effect.fn(function* () {
    return {
      aws: {
        profile: yield* AWS_PROFILE,
        account: yield* AWS_ACCOUNT,
        region: yield* AWS_REGION,
      },
      cloudflare: {
        account: yield* CLOUDFLARE_ACCOUNT_ID,
      },
    };
  }),
);

export const App = stages.ref<typeof stack>("my-aws-app");

const stack = defineStack({
  name: "my-aws-app",
  stages,
  resources: [Api, Consumer],
  providers: Layer.mergeAll(AWS.providers(), Cloudflare.providers()),
});

export default stack;
