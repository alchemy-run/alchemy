import * as Boat from "@alchemy.run/boat";
import * as Effect from "effect/Effect";
import { awsApp, AwsSignedGateway } from "../conformance/aws-app.ts";

/**
 * The AWS conformance program in a Boat sandbox whose gateway only signs:
 * the sandbox sends each request to S3 itself, with a signature made by
 * the gateway's role.
 */
export default class SignedBoat extends Boat.Sandbox<SignedBoat>()(
  "SignedBoat",
  { main: import.meta.url, type: "small", noEnv: true },
  awsApp.pipe(Effect.provide(AwsSignedGateway)),
) {}
