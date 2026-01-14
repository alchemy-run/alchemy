import { defineStack, defineStages, USER } from "alchemy-effect";
import { Api } from "./src/api.ts";
import { Consumer } from "./src/consumer.ts";
import { FileApi } from "./src/file-api.ts";
import { TableConsumer } from "./src/table-consumer.ts";
import * as AWS from "alchemy-effect/aws";
import * as Layer from "effect/Layer";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { Credentials } from "distilled-aws";

const AWS_REGION = Config.string("AWS_REGION").pipe(
  Config.withDefault("us-west-2"),
);

const AWS_PROFILE = Config.string("AWS_PROFILE").pipe(
  Config.withDefault("default"),
);

const stages = defineStages(
  Effect.fn(function* () {
    const profileName = yield* AWS_PROFILE;
    const profile = yield* Credentials.loadProfile(profileName);
    if (!profile.sso_account_id) {
      return yield* Effect.dieMessage(
        `AWS SSO Profile '${profileName}' is missing sso_account_id configuration`,
      );
    }
    return {
      aws: {
        profile: profileName,
        account: profile.sso_account_id,
        region: profile.region ?? (yield* AWS_REGION),
      },
    };
  }),
);

export const App = stages.ref<typeof stack>("my-aws-app").as({
  prod: "prod",
  staging: "staging",
  preview: (pr: number) => `preview_${pr.toString()}`,
  dev: (user: USER = USER) => `dev_${user}`,
});

const stack = defineStack({
  name: "my-aws-app",
  stages,
  resources: [Api, Consumer, FileApi, TableConsumer],
  providers: AWS.providers(),
});

export default stack;
