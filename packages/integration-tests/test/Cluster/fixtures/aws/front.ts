/** The AWS suite's front: a Lambda function calling everything through the gateways. */
import * as Lambda from "@alchemy.run/aws/Lambda";
import { frontApp } from "../app.ts";
import { Tally } from "./tally.ts";

export default class Front extends Lambda.Function<Front>()(
  "ClusterAwsFront",
  { main: import.meta.url, functionUrl: true },
  frontApp(Tally),
) {}
