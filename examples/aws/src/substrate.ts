import * as Effect from "effect/Effect";
import { defineStack, Stack, Resource, $stage } from "alchemy-effect";
import * as EC2 from "alchemy-effect/aws/ec2";
import * as AWS from "alchemy-effect/aws";

// substrate.ts
export class Vpc extends EC2.Vpc("Vpc", {
  cidrBlock: "10.0.0.0/16",
}) {}

const aws = (stage: string = $stage, region: string = "us-west-2") => ({
  account: stage === "prod" ? "0123" : stage === "staging" ? "4567" : "7890",
  region,
});

export type Substrate = typeof Substrate;

export const Substrate = defineStack({
  name: "substrate",
  resources: [Vpc],
  providers: AWS.live(aws()),
});

export default Substrate;

export const substrate = (stage: string = $stage, suffix?: string) =>
  Stack.ref<Substrate>({
    name: "substrate",
    stage: suffix ? `${stage}-${suffix}` : stage,
    aws: aws(stage),
  });

export const prod = substrate("prod");

export const staging = (pr?: number) => substrate("staging", pr?.toString());

export const dev = (user: string = import.meta.env.USER!) => substrate("dev", user);
