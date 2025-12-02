import { defineStack, Stack, $stage } from "alchemy-effect";
import { Api } from "./src/api.ts";
import { Consumer } from "./src/consumer.ts";
import * as AWS from "alchemy-effect/aws";
import * as CF from "alchemy-effect/cloudflare/live";
import * as Layer from "effect/Layer";

const aws = {
  account: import.meta.env.AWS_ACCOUNT!,
  region: import.meta.env.AWS_REGION ?? "us-west-2",
};

const cloudflare = {
  account: import.meta.env.CLOUDFLARE_ACCOUNT_ID!,
};

export type App = typeof AppStack;

export namespace App {
  export const ref = (stage: string = $stage) =>
    Stack.ref<App>({
      name: "my-aws-app",
      stage,
      aws,
      cloudflare,
    });
}

export const AppStack = defineStack({
  name: "my-aws-app",
  resources: [Api, Consumer],
  providers: Layer.mergeAll(AWS.live(aws), CF.live(cloudflare)),
});

export default AppStack;
