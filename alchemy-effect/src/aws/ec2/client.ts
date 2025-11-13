import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import { EC2 } from "itty-aws/ec2";
import { createAWSServiceClientLayer } from "../client.ts";
import * as Credentials from "../credentials.ts";
import * as Region from "../region.ts";

export class EC2Client extends Context.Tag("AWS.EC2.Client")<
  EC2Client,
  EC2
>() {}

export const client = createAWSServiceClientLayer<typeof EC2Client, EC2>(
  EC2Client,
  EC2,
);

export const clientFromEnv = () =>
  Layer.provide(client(), Layer.merge(Credentials.fromEnv(), Region.fromEnv()));
