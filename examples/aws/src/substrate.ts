import {
  type StageConfig,
  defineStack,
  defineStages,
  USER,
} from "alchemy-effect";
import * as Effect from "effect/Effect";
import * as EC2 from "alchemy-effect/aws/ec2";
import * as AWS from "alchemy-effect/aws";

export class Vpc extends EC2.Vpc("Vpc", {
  cidrBlock: "10.0.0.0/16",
}) {}

const stages = defineStages(
  Effect.fn(function* (stage) {
    return {
      aws: {
        account:
          stage === "prod" ? "0123" : stage === "staging" ? "4567" : "7890",
        profile: "default",
      },
    } satisfies StageConfig;
  }),
);

export const Substrate = stages.ref<typeof stack>("substrate").as({
  prod: "prod",
  preview: (pr: number) => `preview_${pr.toString()}`,
  dev: (user: USER = USER) => `dev_${user}`,
});

export const stack = defineStack({
  name: "substrate",
  stages,
  resources: [Vpc],
  providers: AWS.providers(),
});

export default stack;
