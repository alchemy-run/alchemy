/** The AWS suite's front: a Lambda function calling everything through the gateways. */
import * as Lambda from "@alchemy.run/aws/Lambda";
import * as Duration from "effect/Duration";
import { frontApp } from "../app.ts";
import { Tally } from "./tally.ts";

export default class Front extends Lambda.Function<Front>()(
  "ClusterAwsFront",
  // Some routes wait on entities for several seconds; Lambda's default is 3.
  { main: import.meta.url, functionUrl: true, timeout: Duration.seconds(30) },
  frontApp(Tally),
) {}
