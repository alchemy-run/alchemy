import * as Boat from "@alchemy.run/boat";
import * as Effect from "effect/Effect";
import { awsApp, AwsGateway } from "../conformance/aws-app.ts";

/**
 * The AWS conformance program in a Boat sandbox: a host with no AWS
 * identity. Its S3 bindings are granted on the gateway's role, so no AWS
 * key is created for it.
 */
export default class AwsGatewayedBoat extends Boat.Sandbox<AwsGatewayedBoat>()(
  "AwsGatewayedBoat",
  { main: import.meta.url, type: "small", noEnv: true },
  awsApp.pipe(Effect.provide(AwsGateway)),
) {}
